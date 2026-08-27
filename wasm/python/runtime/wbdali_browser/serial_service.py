"""Stands in for the wb-mqtt-serial daemon.

wb-mqtt-dali never touches a serial port: it writes DALI frames into the
gateway's Modbus queue through wb-mqtt-serial's `port/Load` RPC, and reads the
answers from the MQTT controls wb-mqtt-serial publishes for that device. This
module provides both halves against a :class:`ModbusTransport`, so the daemon
cannot tell whether the gateway on the other side is simulated or a real module
on a WebSerial link.

Two RPC methods are served:

* ``config/Load`` — the daemon calls it on startup to discover which devices are
  WB-DALI gateways. It also has to *exist* before `Gateway.start()` will proceed:
  the retained endpoint marker is what `wait_for_rpc_endpoint` waits for.
* ``port/Load`` — a raw Modbus request. The daemon sends these fire-and-forget
  and expects the result to show up as control values, which is what
  :meth:`_publish_reply` does.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol

from .broker import Broker, Client, Message, get_payload_str

logger = logging.getLogger("wbdali_browser.serial")

RPC_REQUEST_FILTER = "/rpc/v1/wb-mqtt-serial/+/+/+"

MODBUS_READ_HOLDING = 3
MODBUS_READ_INPUT = 4
MODBUS_WRITE_SINGLE_HOLDING = 6
MODBUS_WRITE_MULTIPLE_HOLDING = 16


class ModbusTransport(Protocol):
    """What the emulated wb-mqtt-serial needs from whatever sits below it."""

    async def read_holding(self, device_id: str, address: int, count: int) -> List[int]: ...

    async def read_input(self, device_id: str, address: int, count: int) -> List[int]: ...

    async def write_holding(self, device_id: str, address: int, values: List[int]) -> None: ...


def hex_to_registers(message: str) -> List[int]:
    """Decode a `port/Load` HEX payload into 16-bit register values."""
    if len(message) % 4 != 0:
        raise ValueError(f"HEX payload is not a whole number of registers: {message!r}")
    return [int(message[i : i + 4], 16) for i in range(0, len(message), 4)]


def registers_to_hex(registers: List[int]) -> str:
    return "".join(f"{value & 0xFFFF:04x}" for value in registers)


class WbMqttSerialEmulator:
    """Serves wb-mqtt-serial's RPC surface and publishes a WB-DALI device's controls."""

    def __init__(
        self,
        broker: Broker,
        transport: ModbusTransport,
        serial_config: Dict[str, Any],
        client_id: str = "wb-mqtt-serial-emulator",
    ) -> None:
        self.broker = broker
        self.transport = transport
        self.serial_config = serial_config
        self.client = Client(broker, client_id)
        self._task: Optional[asyncio.Task] = None
        self._handlers: Dict[str, Callable[[dict], Awaitable[Any]]] = {
            "/rpc/v1/wb-mqtt-serial/config/Load": self._handle_config_load,
            "/rpc/v1/wb-mqtt-serial/port/Load": self._handle_port_load,
        }

    @property
    def device_ids(self) -> List[str]:
        return [
            device["id"]
            for port in self.serial_config.get("ports", [])
            for device in port.get("devices", [])
            if "id" in device
        ]

    async def start(self) -> None:
        await self.client.__aenter__()
        await self.client.subscribe(RPC_REQUEST_FILTER)

        # The retained marker is what `wait_for_rpc_endpoint` in Gateway.start()
        # blocks on; publish it before the daemon starts.
        for topic in self._handlers:
            self.broker.publish(topic, "1", qos=1, retain=True)

        for device_id in self.device_ids:
            self.publish_availability(device_id, reachable=True)

        self._task = asyncio.create_task(self._serve(), name="wb-mqtt-serial-emulator")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self.client.__aexit__(None, None, None)

    # -- device controls --------------------------------------------------

    def publish_control(self, device_id: str, control: str, value: Any) -> None:
        self.broker.publish(f"/devices/{device_id}/controls/{control}", str(value))

    def publish_availability(self, device_id: str, reachable: bool) -> None:
        """`/meta/error` is `r` while wb-mqtt-serial cannot reach the device."""
        self.broker.publish(f"/devices/{device_id}/meta/error", "" if reachable else "r", retain=True)

    # -- RPC --------------------------------------------------------------

    async def _serve(self) -> None:
        async for message in self.client.messages:
            asyncio.ensure_future(self._dispatch(message))

    async def _dispatch(self, message: Message) -> None:
        topic = message.topic.value
        endpoint, _, _client = topic.rpartition("/")
        handler = self._handlers.get(endpoint)
        if handler is None:
            logger.debug("No wb-mqtt-serial endpoint for %s", topic)
            return

        try:
            request = json.loads(get_payload_str(message))
        except ValueError:
            logger.error("Malformed RPC request on %s: %r", topic, message.payload)
            return

        response: Dict[str, Any] = {"id": request.get("id")}
        try:
            response["result"] = await handler(request.get("params") or {})
        except Exception as error:  # pylint: disable=broad-exception-caught
            logger.exception("wb-mqtt-serial RPC %s failed", topic)
            response["error"] = {"code": -32000, "message": str(error) or type(error).__name__}

        self.broker.publish(topic + "/reply", json.dumps(response), qos=2)

    async def _handle_config_load(self, _params: dict) -> dict:
        return {"config": self.serial_config}

    async def _handle_port_load(self, params: dict) -> dict:
        device_id = params.get("device_id")
        function = int(params.get("function", MODBUS_READ_HOLDING))
        address = int(params.get("address", 0))
        count = int(params.get("count", 1))
        message = params.get("msg", "")

        if function in (MODBUS_WRITE_SINGLE_HOLDING, MODBUS_WRITE_MULTIPLE_HOLDING):
            await self.transport.write_holding(device_id, address, hex_to_registers(message))
            return {"response": ""}

        if function == MODBUS_READ_HOLDING:
            registers = await self.transport.read_holding(device_id, address, count)
        elif function == MODBUS_READ_INPUT:
            registers = await self.transport.read_input(device_id, address, count)
        else:
            raise ValueError(f"Unsupported Modbus function {function}")

        return {"response": registers_to_hex(registers)}
