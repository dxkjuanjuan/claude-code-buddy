"""Shared helpers for the Hardware Buddy Python sidecar."""

from __future__ import annotations

from typing import Any, Dict


JsonObject = Dict[str, Any]

NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"


class SidecarError(Exception):
    def __init__(self, message: str, code: str = "SIDECAR_ERROR") -> None:
        super().__init__(message)
        self.code = code


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


def clean_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
