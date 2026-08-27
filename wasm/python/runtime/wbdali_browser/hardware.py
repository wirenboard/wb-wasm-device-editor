"""Talking to a real WB-DALI module over WebSerial.

The simulated network and this class are the two implementations of
:class:`~wbdali_browser.serial_service.ModbusTransport`; everything above them —
wb-mqtt-dali itself, the emulated wb-mqtt-serial, the web UI — is the same in
both cases.

The difference is who pushes. On a controller, wb-mqtt-serial subscribes to the
gateway's sporadic-event stream and publishes each reply register as it changes.
A browser has one WebSerial link and no event channel, so this polls instead:
after writing a batch into the send queue it reads back exactly the reply slots
that batch occupied, and publishes those. Publishing anything else would be
worse than publishing nothing — a stale slot value republished after the slot
has been reused resolves the *new* command's future with the *old* answer.

Untested against hardware: there was none available. The Modbus framing is
handled by the same C++ wb-mqtt-serial code the Modbus editor already uses, so
what is new here is the polling policy above.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .serial_service import registers_to_hex
from .sim.gateway import BUS_ADDRESS_OFFSET, QUEUE_BASE, QUEUE_SIZE, REPLY_BASE

logger = logging.getLogger("wbdali_browser.hardware")

MODBUS_READ_HOLDING = 3
MODBUS_READ_INPUT = 4
MODBUS_WRITE_MULTIPLE_HOLDING = 16

# How long to keep re-reading a reply slot before giving up on it. The driver's
# own per-command timeout is 1.5 s, so this has to be comfortably shorter or the
# driver reports "no response from gateway" while an answer is still on its way.
REPLY_POLL_TIMEOUT_S = 1.0
REPLY_POLL_INTERVAL_S = 0.02

# A reply register still reading 0 means the gateway has not transmitted that
# slot yet; every completed transmission sets a non-zero status byte.
REPLY_PENDING = 0

# After this many consecutive failures the module is reported unreachable on
# `/meta/error`, which makes the driver fail its pending traffic immediately
# instead of waiting out a 1.5 s timeout per command. Without it, a gateway that
# is simply not there turns every bus operation into a long stall — and the
# daemon's own retries keep the requests coming.
FAILURES_BEFORE_UNREACHABLE = 3

PortLoad = Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]


class ModbusError(Exception):
    """The gateway did not answer, or answered with a Modbus exception."""


class WasmSerialTransport:
    """A WB-DALI module reached through the C++ WASM module's `port/Load` RPC.

    :param port_load: `Module.request('portLoad', ...)`, awaited
    :param slave_ids: MQTT device id of each module, mapped to its Modbus address
    :param publish_control: called as ``(device_id, control, value)`` to publish a
        register the driver is waiting on
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
        self._publish_control: Optional[Callable[[str, str, Any], None]] = None
        self._publish_availability: Optional[Callable[[str, bool], None]] = None
        self._failures: Dict[str, int] = {}
        self._unreachable: set = set()
        # One RS-485 link: requests to any module have to be serialised.
        self._lock = asyncio.Lock()

    def bind(
        self,
        publish_control: Callable[[str, str, Any], None],
        publish_availability: Optional[Callable[[str, bool], None]] = None,
    ) -> None:
        self._publish_control = publish_control
        self._publish_availability = publish_availability

    # -- ModbusTransport --------------------------------------------------

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

        slots = queue_slots_written(address, len(values))
        if slots is not None:
            bus, first_slot, slot_count = slots
            await self._collect_replies(device_id, bus, first_slot, slot_count)

    # -- reply collection -------------------------------------------------

    async def _collect_replies(self, device_id: str, bus: int, first_slot: int, count: int) -> None:
        """Read back the reply slots a batch occupied and publish them.

        Only these slots: a reply register keeps its value until the slot is
        reused, so republishing one the driver has already consumed would resolve
        a later command with an earlier command's answer.
        """
        base = REPLY_BASE + (bus - 1) * BUS_ADDRESS_OFFSET + first_slot
        pending = set(range(count))
        deadline = asyncio.get_running_loop().time() + REPLY_POLL_TIMEOUT_S

        while pending and asyncio.get_running_loop().time() < deadline:
            async with self._lock:
                try:
                    values = await self._read_input_locked(device_id, base, count)
                except ModbusError as error:
                    logger.warning("Reading DALI replies from %s failed: %s", device_id, error)
                    return

            for offset in sorted(pending):
                if values[offset] == REPLY_PENDING:
                    continue
                pending.discard(offset)
                self._publish(
                    device_id,
                    f"bus_{bus}_bulk_send_reply_{first_slot + offset}",
                    values[offset],
                )

            if pending:
                await asyncio.sleep(REPLY_POLL_INTERVAL_S)

        if pending:
            # The driver's own timeout will report this; saying so here names the
            # slots, which is what makes a stuck queue diagnosable.
            logger.warning(
                "Gateway %s bus %d did not transmit slots %s",
                device_id,
                bus,
                sorted(first_slot + offset for offset in pending),
            )

    def _publish(self, device_id: str, control: str, value: Any) -> None:
        if self._publish_control is None:
            logger.debug("Dropping %s/%s: no publisher bound", device_id, control)
            return
        self._publish_control(device_id, control, value)

    # -- Modbus -----------------------------------------------------------

    async def _read(self, device_id: str, function: int, address: int, count: int) -> List[int]:
        async with self._lock:
            return await self._read_locked(device_id, function, address, count)

    async def _read_input_locked(self, device_id: str, address: int, count: int) -> List[int]:
        return await self._read_locked(device_id, MODBUS_READ_INPUT, address, count)

    async def _read_locked(self, device_id: str, function: int, address: int, count: int) -> List[int]:
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
            self._note_failure(device_id)
            raise ModbusError(str(reply["error"]))
        self._note_success(device_id)
        return reply

    def _note_failure(self, device_id: str) -> None:
        self._failures[device_id] = self._failures.get(device_id, 0) + 1
        if self._failures[device_id] < FAILURES_BEFORE_UNREACHABLE:
            return
        if device_id in self._unreachable:
            return
        logger.warning("Gateway %s is not answering; reporting it unreachable", device_id)
        self._unreachable.add(device_id)
        if self._publish_availability is not None:
            self._publish_availability(device_id, False)

    def _note_success(self, device_id: str) -> None:
        self._failures[device_id] = 0
        if device_id in self._unreachable:
            logger.info("Gateway %s is answering again", device_id)
            self._unreachable.discard(device_id)
            if self._publish_availability is not None:
                self._publish_availability(device_id, True)


def queue_slots_written(address: int, register_count: int):
    """Which send-queue slots a write covered, or ``None`` if it was elsewhere.

    A slot is two registers, and bus 2 and 3 repeat the map at +1000 and +2000.
    """
    bus = (address - QUEUE_BASE) // BUS_ADDRESS_OFFSET + 1
    local = address - (bus - 1) * BUS_ADDRESS_OFFSET
    if not QUEUE_BASE <= local < QUEUE_BASE + QUEUE_SIZE * 2:
        return None
    first_slot = (local - QUEUE_BASE) // 2
    return bus, first_slot, max(1, register_count // 2)


def hex_to_registers(message: str) -> List[int]:
    if len(message) % 4 != 0:
        raise ModbusError(f"Modbus reply is not a whole number of registers: {message!r}")
    return [int(message[index : index + 4], 16) for index in range(0, len(message), 4)]
