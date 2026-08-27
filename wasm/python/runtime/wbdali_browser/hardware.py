"""Reading and writing a real WB-DALI module's registers over WebSerial.

The simulated network and this class are the two implementations of the same
`RegisterTransport`; everything above them — the DALI driver, wb-mqtt-dali
itself, the web UI — is identical either way.

There is nothing DALI-specific here. Framing, retries and timeouts are handled
by the C++ wb-mqtt-serial code the Modbus editor already uses, reached through
its `port/Load` RPC; the DALI protocol on top is the driver's business.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .registers import to_registers

logger = logging.getLogger("wbdali_browser.hardware")

MODBUS_READ_HOLDING = 3
MODBUS_READ_INPUT = 4
MODBUS_WRITE_MULTIPLE_HOLDING = 16

PortLoad = Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]


class ModbusError(Exception):
    """The gateway did not answer, or answered with a Modbus exception."""


class WasmSerialTransport:
    """A WB-DALI module reached through the C++ WASM module's `port/Load` RPC.

    :param port_load: `Module.request('portLoad', ...)`, awaited
    :param slave_ids: MQTT device id of each module, mapped to its Modbus address
    :param serial_settings: baud rate, parity and so on for the RS-485 link
    """

    def __init__(
        self,
        port_load: PortLoad,
        slave_ids: Dict[str, int],
        serial_settings: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._port_load = port_load
        self._slave_ids = dict(slave_ids)
        self._serial_settings = serial_settings or {
            "baud_rate": 9600,
            "data_bits": 8,
            "parity": "N",
            "stop_bits": 2,
        }
        # One RS-485 link: requests to any module have to be serialised.
        self._lock = asyncio.Lock()

    # -- RegisterTransport ------------------------------------------------

    async def read_holding(self, device_id: str, address: int, count: int) -> List[int]:
        return await self._read(device_id, MODBUS_READ_HOLDING, address, count)

    async def read_input(self, device_id: str, address: int, count: int) -> List[int]:
        return await self._read(device_id, MODBUS_READ_INPUT, address, count)

    async def write_holding(self, device_id: str, address: int, values: List[int]) -> None:
        async with self._lock:
            await self._request(
                device_id,
                {
                    "function": MODBUS_WRITE_MULTIPLE_HOLDING,
                    "address": address,
                    "count": len(values),
                    "msg": registers_to_hex(values),
                },
            )

    async def _read(self, device_id: str, function: int, address: int, count: int) -> List[int]:
        async with self._lock:
            reply = await self._request(
                device_id, {"function": function, "address": address, "count": count}
            )
        return hex_to_registers(reply.get("response", ""))

    async def _request(self, device_id: str, request: Dict[str, Any]) -> Dict[str, Any]:
        slave_id = self._slave_ids.get(device_id)
        if slave_id is None:
            raise ModbusError(f"no Modbus address known for {device_id!r}")

        payload = {
            "protocol": "modbus",
            "slave_id": slave_id,
            "format": "HEX",
            **self._serial_settings,
            **request,
        }
        reply = await self._port_load(payload)
        reply = dict(reply) if reply is not None else {}
        if reply.get("error"):
            raise ModbusError(str(reply["error"]))
        return reply


def registers_to_hex(registers: List[int]) -> str:
    return "".join(f"{value & 0xFFFF:04x}" for value in registers)


def hex_to_registers(message: str) -> List[int]:
    if len(message) % 4 != 0:
        raise ModbusError(f"Modbus reply is not a whole number of registers: {message!r}")
    return [int(message[index : index + 4], 16) for index in range(0, len(message), 4)]
