#!/usr/bin/env python3
"""Hardware Buddy sidecar stdio bridge.

This is the process boundary used by the Node bridge core. It speaks compact
newline-delimited JSON on stdin/stdout. The BLE backend is intentionally behind
a small interface so tests can run with the fake backend before a bleak-backed
implementation is added.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Any, List, Optional, Protocol

from hardware_buddy_common import JsonObject, SidecarError, clean_string, is_object


class JsonLineIO:
    def __init__(self, stdin: Any, stdout: Any) -> None:
        self.stdin = stdin
        self.stdout = stdout
        self._write_lock = asyncio.Lock()

    async def read_line(self) -> str:
        return await asyncio.to_thread(self.stdin.readline)

    async def write(self, message: JsonObject) -> None:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n"
        async with self._write_lock:
            self.stdout.write(line)
            self.stdout.flush()

    async def error(self, message: str, code: str = "SIDECAR_ERROR") -> None:
        await self.write({"type": "error", "message": message, "code": code})

    async def log(self, level: str, message: str) -> None:
        await self.write({"type": "log", "level": level, "message": message})


class HardwareBuddyBackend(Protocol):
    async def scan(self) -> JsonObject: ...
    async def connect(self, data: JsonObject) -> JsonObject: ...
    async def disconnect(self) -> JsonObject: ...
    async def unpair(self) -> JsonObject: ...
    async def status(self, *, ok: bool = True) -> JsonObject: ...
    async def set_owner(self, data: JsonObject) -> JsonObject: ...
    async def set_name(self, data: JsonObject) -> JsonObject: ...
    async def set_time(self, data: JsonObject) -> JsonObject: ...
    async def handle_snapshot(self, data: JsonObject) -> None: ...


@dataclass
class FakeDevice:
    address: str
    name: str
    rssi: int
    identifier: str = ""

    def scan_item(self) -> JsonObject:
        item: JsonObject = {
            "address": self.address,
            "name": self.name,
            "rssi": self.rssi,
        }
        if self.identifier:
            item["id"] = self.identifier
        return item


class FakeBackend:
    emit_snapshot_log = True

    def __init__(self, *, secure_on_connect: bool = True) -> None:
        self.devices = [
            FakeDevice(
                address="FAKE:CLAWSTICK",
                name="Clawstick Fake",
                rssi=-42,
                identifier="fake-clawstick",
            )
        ]
        self.secure_on_connect = secure_on_connect
        self.connected = False
        self.secure = False
        self.owner = ""
        self.device_name = self.devices[0].name
        self.time_epoch = 0.0
        self.time_offset = 0.0
        self.last_snapshot: Optional[JsonObject] = None
        self.current_device: Optional[FakeDevice] = None

    async def scan(self) -> JsonObject:
        return {"type": "devices", "items": [device.scan_item() for device in self.devices]}

    async def connect(self, data: JsonObject) -> JsonObject:
        requested = clean_string(data.get("address")) or clean_string(data.get("id")) or clean_string(data.get("name"))
        if not requested:
            raise SidecarError("connect requires data.address, id, or name", "BAD_CONTROL")
        device = self._find_device(requested)
        if device is None:
            raise SidecarError("device not found", "NO_DEVICE")
        self.connected = True
        self.secure = self.secure_on_connect
        self.current_device = device
        self.device_name = device.name
        return await self.status(ok=True)

    async def disconnect(self) -> JsonObject:
        self.connected = False
        self.secure = False
        return await self.status(ok=True)

    async def unpair(self) -> JsonObject:
        self.connected = False
        self.secure = False
        self.current_device = None
        return await self.status(ok=True)

    async def status(self, *, ok: bool = True) -> JsonObject:
        device = self.current_device or self.devices[0]
        return {
            "type": "status",
            "connected": self.connected,
            "secure": self.secure,
            "ok": ok,
            "data": {
                "name": self.device_name,
                "owner": self.owner,
                "sec": self.secure,
                "batt": 100,
            },
            "device": device.scan_item(),
        }

    async def set_owner(self, data: JsonObject) -> JsonObject:
        owner = clean_string(data.get("name"))
        if not owner:
            raise SidecarError("set_owner requires data.name", "BAD_CONTROL")
        self.owner = owner
        return await self.status(ok=True)

    async def set_name(self, data: JsonObject) -> JsonObject:
        name = clean_string(data.get("name"))
        if not name:
            raise SidecarError("set_name requires data.name", "BAD_CONTROL")
        self.device_name = name
        if self.current_device:
            self.current_device.name = name
        return await self.status(ok=True)

    async def set_time(self, data: JsonObject) -> JsonObject:
        try:
            self.time_epoch = float(data.get("epoch"))
            self.time_offset = float(data.get("offset"))
        except (TypeError, ValueError):
            raise SidecarError("set_time requires finite data.epoch and data.offset", "BAD_CONTROL")
        if not self._is_finite(self.time_epoch) or not self._is_finite(self.time_offset):
            raise SidecarError("set_time requires finite data.epoch and data.offset", "BAD_CONTROL")
        return await self.status(ok=True)

    async def handle_snapshot(self, data: JsonObject) -> None:
        if not is_object(data):
            raise SidecarError("snapshot data must be an object", "BAD_SNAPSHOT")
        self.last_snapshot = data

    async def simulate_permission(self, data: JsonObject) -> JsonObject:
        prompt_id = clean_string(data.get("id"))
        decision = clean_string(data.get("decision"))
        if not prompt_id or decision not in ("once", "deny"):
            raise SidecarError("simulate_permission requires data.id and decision once or deny", "BAD_CONTROL")
        return {"type": "command", "data": {"cmd": "permission", "id": prompt_id, "decision": decision}}

    def _find_device(self, requested: str) -> Optional[FakeDevice]:
        for device in self.devices:
            if requested in (device.address, device.identifier, device.name):
                return device
        return None

    @staticmethod
    def _is_finite(value: float) -> bool:
        return value == value and value not in (float("inf"), float("-inf"))


class SidecarApp:
    def __init__(self, backend: HardwareBuddyBackend, io: JsonLineIO) -> None:
        self.backend = backend
        self.io = io

    async def run(self) -> int:
        while True:
            raw_line = await self.io.read_line()
            if raw_line == "":
                return 0
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
                await self.handle_message(message)
            except json.JSONDecodeError as err:
                await self.io.error(f"invalid sidecar JSON: {err.msg}", "BAD_JSON")
            except SidecarError as err:
                await self.io.error(str(err), err.code)
            except Exception as err:  # pragma: no cover - defensive process boundary
                await self.io.error(str(err), "UNHANDLED")

    async def handle_message(self, message: Any) -> None:
        if not is_object(message):
            raise SidecarError("sidecar message must be an object", "BAD_MESSAGE")
        message_type = clean_string(message.get("type"))
        if message_type == "snapshot":
            await self.backend.handle_snapshot(message.get("data"))
            if getattr(self.backend, "emit_snapshot_log", False):
                await self.io.log("debug", "snapshot received")
            return
        if message_type == "control":
            await self.handle_control(message)
            return
        raise SidecarError(f"unsupported sidecar message type: {message_type}", "BAD_MESSAGE")

    async def handle_control(self, message: JsonObject) -> None:
        action = clean_string(message.get("action"))
        data = message.get("data") if is_object(message.get("data")) else {}
        if action == "scan":
            await self.io.write(await self.backend.scan())
            return
        if action == "connect":
            await self.io.write(await self.backend.connect(data))
            return
        if action == "disconnect":
            await self.io.write(await self.backend.disconnect())
            return
        if action == "status":
            poll_device_status = getattr(self.backend, "poll_device_status", None)
            if callable(poll_device_status):
                await poll_device_status()
            await self.io.write(await self.backend.status(ok=True))
            return
        if action == "unpair":
            await self.io.write(await self.backend.unpair())
            return
        if action == "set_owner":
            await self.io.write(await self.backend.set_owner(data))
            return
        if action == "set_name":
            await self.io.write(await self.backend.set_name(data))
            return
        if action == "set_time":
            await self.io.write(await self.backend.set_time(data))
            return
        if action == "simulate_permission":
            simulate_permission = getattr(self.backend, "simulate_permission", None)
            if not callable(simulate_permission):
                raise SidecarError("simulate_permission is supported by the fake backend only", "BAD_CONTROL")
            await self.io.write(await simulate_permission(data))
            return
        raise SidecarError(f"unsupported control action: {action}", "BAD_CONTROL")


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hardware Buddy stdio sidecar")
    parser.add_argument("--backend", choices=["fake", "bleak"], default="fake")
    parser.add_argument(
        "--fake-secure",
        choices=["true", "false"],
        default="true",
        help="whether the fake backend reports a secure link after connect",
    )
    parser.add_argument("--scan-timeout", type=float, default=5.0)
    parser.add_argument("--connect-timeout", type=float, default=10.0)
    parser.add_argument("--name-prefix", default="Claude")
    parser.add_argument(
        "--pair",
        action="store_true",
        help="ask bleak to initiate best-effort OS pairing during BLE connect",
    )
    return parser.parse_args(argv)


def create_backend(args: argparse.Namespace, io: JsonLineIO) -> HardwareBuddyBackend:
    if args.backend == "fake":
        return FakeBackend(secure_on_connect=args.fake_secure == "true")
    if args.backend == "bleak":
        from backends.bleak_backend import BleakBackend

        return BleakBackend(
            io,
            scan_timeout=args.scan_timeout,
            connect_timeout=args.connect_timeout,
            name_prefix=args.name_prefix,
            pair=args.pair,
        )
    raise SidecarError(f"unsupported backend: {args.backend}", "BAD_BACKEND")


async def async_main(argv: List[str]) -> int:
    args = parse_args(argv)
    io = JsonLineIO(sys.stdin, sys.stdout)
    try:
        backend = create_backend(args, io)
    except SidecarError as err:
        await io.error(str(err), err.code)
        return 1
    return await SidecarApp(backend, io).run()


def main(argv: List[str]) -> int:
    return asyncio.run(async_main(argv))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
