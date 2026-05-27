"""Bleak-backed Nordic UART backend for the Hardware Buddy sidecar.

Security caveat for v1: this backend does not independently verify the OS BLE
bond/encryption state. Prompt eligibility remains fail-closed until the device
reports ``{"ack":"status","data":{"sec":true}}`` over NUS TX. The ``pair``
option is best-effort only: Windows passkey-entry pairing may still need to be
completed through the system Bluetooth settings UI.

Unpair is best-effort cleanup: the backend sends the device unpair command and
then asks the host BLE stack to unpair when that API exists.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Dict, Iterable, Optional, Tuple, Union

from hardware_buddy_common import (
    JsonObject,
    NUS_RX_UUID,
    NUS_SERVICE_UUID,
    NUS_TX_UUID,
    SidecarError,
    clean_string,
    is_object,
)


def _load_bleak() -> Tuple[Any, Any, Any]:
    try:
        from bleak import BleakClient, BleakScanner
        from bleak.exc import BleakError
    except ModuleNotFoundError as err:
        raise SidecarError(
            "bleak backend requires the optional 'bleak' package",
            "MISSING_BLEAK",
        ) from err
    return BleakClient, BleakScanner, BleakError


class BleakBackend:
    def __init__(
        self,
        io: Any,
        *,
        scan_timeout: float = 5.0,
        connect_timeout: float = 10.0,
        name_prefix: str = "Claude",
        pair: bool = False,
    ) -> None:
        self.BleakClient, self.BleakScanner, self.BleakError = _load_bleak()
        self.io = io
        self.scan_timeout = max(0.5, float(scan_timeout))
        self.connect_timeout = max(1.0, float(connect_timeout))
        self.name_prefix = name_prefix
        self.pair = pair is True
        self.client: Any = None
        self.device: Any = None
        self.rx_char: Any = NUS_RX_UUID
        self.tx_char: Any = NUS_TX_UUID
        self.connected = False
        self.secure = False
        self.last_status_data: JsonObject = {}
        self.last_device_item: JsonObject = {}
        self.last_snapshot: Optional[JsonObject] = None
        self.known_devices: Dict[str, Any] = {}
        self.notify_buffer = ""
        self.intentional_disconnect = False
        self.intentional_disconnect_client: Any = None

    async def scan(self) -> JsonObject:
        discovered = await self.BleakScanner.discover(
            timeout=self.scan_timeout,
            return_adv=True,
            service_uuids=[NUS_SERVICE_UUID],
        )
        items = []
        self.known_devices = {}

        for device, adv in self._iter_discovered(discovered):
            if not self._matches_device(device, adv):
                continue
            item = self._device_item(device, adv)
            items.append(item)
            self._remember_device(device, item)

        return {"type": "devices", "items": items}

    async def connect(self, data: JsonObject) -> JsonObject:
        requested_address = clean_string(data.get("address"))
        requested_id = clean_string(data.get("id"))
        requested_name = clean_string(data.get("name"))
        requested = requested_address or requested_id or requested_name
        if not requested:
            raise SidecarError("connect requires data.address, id, or name", "BAD_CONTROL")

        direct_identifier = requested_address or requested_id
        device = self.known_devices.get(requested)
        if device is None:
            if self._looks_like_direct_identifier(direct_identifier):
                device = await self._find_device_by_address(direct_identifier)
            else:
                device = await self._find_device(requested)
        if device is None:
            raise SidecarError("device not found", "NO_DEVICE")

        await self.disconnect()
        self.device = device
        self.client = self.BleakClient(
            device,
            disconnected_callback=self._on_disconnected,
            services=[NUS_SERVICE_UUID],
            timeout=self.connect_timeout,
            pair=self.pair,
        )
        self.intentional_disconnect = False
        self.intentional_disconnect_client = None
        try:
            await self.client.connect()
            self.connected = bool(getattr(self.client, "is_connected", False))
            if not self.connected:
                raise SidecarError("failed to connect to device", "CONNECT_FAILED")

            self._resolve_characteristics()
            await self.client.start_notify(self.tx_char, self._on_notify)
            self.last_device_item = self._device_item(device, None)
            await self._write_wire({"cmd": "status"})
            return await self.status(ok=True)
        except Exception as err:
            await self.disconnect()
            if self._is_authentication_error(err):
                raise SidecarError(
                    "device requires BLE pairing/bonding before NUS access",
                    "AUTH_REQUIRED",
                ) from err
            raise

    async def disconnect(self) -> JsonObject:
        client = self.client
        if client is not None:
            try:
                if bool(getattr(client, "is_connected", False)):
                    self.intentional_disconnect = True
                    self.intentional_disconnect_client = client
                    await client.stop_notify(self.tx_char)
            except Exception as err:
                if not self._is_authentication_error(err):
                    await self.io.log("warn", f"stop notify during disconnect failed: {err}")
            try:
                if bool(getattr(client, "is_connected", False)):
                    self.intentional_disconnect = True
                    self.intentional_disconnect_client = client
                    await client.disconnect()
            except Exception as err:
                if not self._is_authentication_error(err):
                    await self.io.log("warn", f"device disconnect failed: {err}")
        self._mark_disconnected()
        return await self.status(ok=True)

    async def unpair(self) -> JsonObject:
        client = self.client
        if client is not None and bool(getattr(client, "is_connected", False)):
            try:
                await self._write_wire({"cmd": "unpair"})
            except SidecarError:
                pass
            unpair = getattr(client, "unpair", None)
            if callable(unpair):
                try:
                    await unpair()
                except Exception as err:
                    await self.io.log("warn", f"host unpair failed: {err}")
        await self.disconnect()
        return await self.status(ok=True)

    async def status(self, *, ok: bool = True) -> JsonObject:
        if self._is_client_connected():
            self.connected = True
        status: JsonObject = {
            "type": "status",
            "connected": self.connected,
            "secure": self.secure,
            "ok": ok,
            "data": self.last_status_data,
        }
        if self.last_device_item:
            status["device"] = self.last_device_item
        return status

    async def set_owner(self, data: JsonObject) -> JsonObject:
        name = clean_string(data.get("name"))
        if not name:
            raise SidecarError("set_owner requires data.name", "BAD_CONTROL")
        await self._write_wire({"cmd": "owner", "name": name})
        return await self.status(ok=True)

    async def set_name(self, data: JsonObject) -> JsonObject:
        name = clean_string(data.get("name"))
        if not name:
            raise SidecarError("set_name requires data.name", "BAD_CONTROL")
        await self._write_wire({"cmd": "name", "name": name})
        return await self.status(ok=True)

    async def set_time(self, data: JsonObject) -> JsonObject:
        try:
            epoch = float(data.get("epoch"))
            offset = float(data.get("offset"))
        except (TypeError, ValueError):
            raise SidecarError("set_time requires finite data.epoch and data.offset", "BAD_CONTROL")
        if not self._is_finite(epoch) or not self._is_finite(offset):
            raise SidecarError("set_time requires finite data.epoch and data.offset", "BAD_CONTROL")
        await self._write_wire({"time": [self._json_number(epoch), self._json_number(offset)]})
        return await self.status(ok=True)

    async def handle_snapshot(self, data: JsonObject) -> None:
        if not is_object(data):
            raise SidecarError("snapshot data must be an object", "BAD_SNAPSHOT")
        self.last_snapshot = data
        # Snapshot is a high-frequency auto-push. Dropping while disconnected
        # avoids flooding the desktop with NOT_CONNECTED errors on keepalive.
        if self.connected:
            await self._write_wire(data)

    async def poll_device_status(self) -> None:
        if self.connected:
            await self._write_wire({"cmd": "status"})

    def _on_disconnected(self, _client: Any) -> None:
        if _client is not None and self.client is not None and _client is not self.client:
            return
        intentional = (
            self.intentional_disconnect
            and (
                self.intentional_disconnect_client is None
                or _client is self.intentional_disconnect_client
                or self.client is None
            )
        )
        self._mark_disconnected()
        if intentional:
            return
        # Bleak schedules disconnected_callback on the event loop in normal
        # backends. If a future backend calls from another thread, the next
        # controller keepalive still observes connected=false / secure=false.
        try:
            asyncio.get_running_loop().create_task(self._emit_disconnect_status())
        except RuntimeError:
            pass

    async def _emit_disconnect_status(self) -> None:
        await self.io.write(await self.status(ok=False))

    async def _on_notify(self, _sender: Any, data: bytearray) -> None:
        self.notify_buffer += bytes(data).decode("utf-8", errors="replace")
        while "\n" in self.notify_buffer:
            line, self.notify_buffer = self.notify_buffer.split("\n", 1)
            await self._handle_wire_line(line.strip())

    async def _handle_wire_line(self, line: str) -> None:
        if not line:
            return
        try:
            message = json.loads(line)
        except json.JSONDecodeError as err:
            await self.io.error(f"invalid device JSON: {err.msg}", "BAD_DEVICE_JSON")
            return
        if not is_object(message):
            await self.io.error("device message must be an object", "BAD_DEVICE_MESSAGE")
            return

        if message.get("ack") == "status":
            data = message.get("data") if is_object(message.get("data")) else {}
            self.last_status_data = data
            self.secure = data.get("sec") is True
            await self.io.write({
                "type": "status",
                "connected": self.connected,
                "secure": self.secure,
                "ok": message.get("ok") is True,
                "data": data,
                **({"device": self.last_device_item} if self.last_device_item else {}),
            })
            return

        if isinstance(message.get("cmd"), str) or isinstance(message.get("ack"), str):
            await self.io.write({"type": "command", "data": message})
            return

        await self.io.log("warn", "ignored device message without cmd or ack")

    async def _write_wire(self, payload: JsonObject) -> None:
        if not self._is_client_connected():
            self._mark_disconnected()
            raise SidecarError("device is not connected", "NOT_CONNECTED")
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
        data = line.encode("utf-8")
        chunk_size = self._write_chunk_size()
        with_response = len(data) > chunk_size
        for start in range(0, len(data), chunk_size):
            await self.client.write_gatt_char(
                self.rx_char,
                data[start:start + chunk_size],
                response=with_response,
            )
            if start + chunk_size < len(data):
                await asyncio.sleep(0.01)

    async def _find_device(self, requested: str) -> Any:
        def match(device: Any, adv: Any) -> bool:
            item = self._device_item(device, adv)
            if requested in (item.get("address"), item.get("id"), item.get("name")):
                return self._matches_device(device, adv)
            return False

        device = await self.BleakScanner.find_device_by_filter(
            match,
            timeout=self.scan_timeout,
            service_uuids=[NUS_SERVICE_UUID],
        )
        if device is not None:
            self._remember_device(device, self._device_item(device, None))
        return device

    async def _find_device_by_address(self, requested: str) -> Any:
        # On Windows the scan result sometimes omits advertised service data on
        # reconnect. Match the explicit address first, then verify NUS after the
        # connection when characteristics are resolved.
        finder = getattr(self.BleakScanner, "find_device_by_address", None)
        if callable(finder):
            device = await finder(requested, timeout=self.scan_timeout)
        else:
            requested_lower = requested.lower()
            device = await self.BleakScanner.find_device_by_filter(
                lambda d, _ad: clean_string(getattr(d, "address", "")).lower() == requested_lower,
                timeout=self.scan_timeout,
            )
        if device is not None:
            self._remember_device(device, self._device_item(device, None))
        return device

    def _resolve_characteristics(self) -> None:
        services = getattr(self.client, "services", None)
        getter = getattr(services, "get_characteristic", None)
        if not callable(getter):
            return
        rx_char = getter(NUS_RX_UUID)
        tx_char = getter(NUS_TX_UUID)
        if rx_char is None or tx_char is None:
            raise SidecarError("device does not expose Nordic UART characteristics", "BAD_DEVICE")
        self.rx_char = rx_char
        self.tx_char = tx_char

    def _write_chunk_size(self) -> int:
        raw = getattr(self.rx_char, "max_write_without_response_size", 20)
        try:
            size = int(raw)
        except (TypeError, ValueError):
            size = 20
        return max(20, min(size, 180))

    def _iter_discovered(self, discovered: Any) -> Iterable[Tuple[Any, Any]]:
        if isinstance(discovered, dict):
            return discovered.values()
        return ((device, None) for device in discovered)

    def _matches_device(self, device: Any, adv: Any) -> bool:
        service_uuids = [str(uuid).lower() for uuid in getattr(adv, "service_uuids", []) or []]
        has_nus = NUS_SERVICE_UUID.lower() in service_uuids
        name = self._device_name(device, adv)
        has_prefix = bool(self.name_prefix and name.startswith(self.name_prefix))
        return has_nus or has_prefix

    def _device_item(self, device: Any, adv: Any) -> JsonObject:
        item: JsonObject = {}
        address = clean_string(getattr(device, "address", ""))
        name = self._device_name(device, adv)
        rssi = getattr(adv, "rssi", None)
        if rssi is None:
            rssi = getattr(device, "rssi", None)
        if address:
            item["address"] = address
            item["id"] = address
        if name:
            item["name"] = name
        if isinstance(rssi, (int, float)):
            item["rssi"] = int(rssi)
        if not item:
            item["id"] = repr(device)
        return item

    def _device_name(self, device: Any, adv: Any) -> str:
        return clean_string(getattr(adv, "local_name", "")) or clean_string(getattr(device, "name", ""))

    def _remember_device(self, device: Any, item: JsonObject) -> None:
        for key in (item.get("address"), item.get("id"), item.get("name")):
            if isinstance(key, str) and key:
                self.known_devices[key] = device

    @staticmethod
    def _looks_like_direct_identifier(value: str) -> bool:
        if not value:
            return False
        return (
            re.fullmatch(r"[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}", value) is not None
            or re.fullmatch(r"[0-9A-Fa-f]{12}", value) is not None
            or re.fullmatch(
                r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}",
                value,
            ) is not None
        )

    def _is_client_connected(self) -> bool:
        return self.client is not None and bool(getattr(self.client, "is_connected", False))

    def _mark_disconnected(self) -> None:
        self.connected = False
        self.secure = False
        self.client = None
        self.rx_char = NUS_RX_UUID
        self.tx_char = NUS_TX_UUID

    @staticmethod
    def _is_finite(value: float) -> bool:
        return value == value and value not in (float("inf"), float("-inf"))

    @staticmethod
    def _json_number(value: float) -> Union[int, float]:
        return int(value) if value.is_integer() else value

    @staticmethod
    def _is_authentication_error(err: Exception) -> bool:
        needles = (
            "insufficient authentication",
            "authentication is required",
            "access is denied",
            "access denied",
            "not authorized",
            "0x80650005",
        )
        compact_needles = (
            "accessdenied",
            "gattcommunicationstatus.accessdenied",
        )

        for message in BleakBackend._exception_messages(err):
            lower = message.lower()
            compact = re.sub(r"[\s_]+", "", lower)
            if any(needle in lower for needle in needles):
                return True
            if any(needle in compact for needle in compact_needles):
                return True
            if "gatt protocol error" in lower and "authentication" in lower:
                return True
        return False

    @staticmethod
    def _exception_messages(err: Exception) -> Iterable[str]:
        current: Optional[BaseException] = err
        seen = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            message = str(current)
            if message:
                yield message
            current = current.__cause__ or current.__context__
