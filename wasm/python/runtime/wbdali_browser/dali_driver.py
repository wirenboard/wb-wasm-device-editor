"""A blocking DALI driver: send one frame, poll for its answer.

This replaces `wb.mqtt_dali.wbdali.WBDALIDriver`, whose job is to be fast on a
controller. There it batches up to sixteen frames into the gateway's send queue,
lets wb-mqtt-serial stream the results back as sporadic Modbus events, and
reassembles them by matching MQTT reply topics to queued futures. In a browser
none of that machinery buys anything: there is one WebSerial link, one request
in flight at a time, and no event channel to subscribe to. What is left when you
take it away is the protocol itself — write a frame into a queue slot, read the
matching reply register — and that is all this does.

The interface is the one the daemon uses (`initialize`, `deinitialize`, `send`,
`send_commands`, `run_sequence`, `bus_traffic`), so `ApplicationController`,
commissioning and every device class run unmodified on top of it.

One firmware behaviour is assumed and could not be checked without hardware:
**writing a queue slot clears its reply register until the frame has been
transmitted**, so a non-zero status means "this frame's answer". The simulated
gateway models it, and it is the only reading under which a reply register is
usable at all — a register that kept its previous value would be
indistinguishable from a fresh identical answer, and answers repeat constantly
(every QUERY CONTROL GEAR PRESENT on a populated bus returns the same byte).
Slots are still used round-robin, so if a real module turns out not to clear
them, a stale value is at least sixteen commands old rather than one.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, List, Optional, Protocol, Sequence, Union

from dali.command import Command, Response
from dali.device.helpers import DeviceInstanceTypeMapper
from dali.frame import BackwardFrame, BackwardFrameError
from dali.gear.general import EnableDeviceType
from dali.sequences import progress as seq_progress
from dali.sequences import sleep as seq_sleep

from wb.mqtt_dali.bus_traffic import BusTrafficCallbacks, BusTrafficSource
from wb.mqtt_dali.wbdali import FramePriority, WBDALIConfig, _compute_frame_priorities
from wb.mqtt_dali.wbdali_error_response import (
    NoPowerOnBus,
    NoResponseFromGateway,
    NoTransmission,
    Overheat,
)

from .registers import (
    QUEUE_SIZE,
    TransmissionStatus,
    decode_reply,
    encode_frame,
    queue_pointer_address,
    queue_slot_address,
    reply_address,
    to_registers,
)

# How long to keep reading a reply register before declaring the frame lost.
# A DALI forward frame plus its backward frame and settling time is about 35 ms;
# the rest is headroom for a slow serial link.
RESPONSE_TIMEOUT_S = 1.0
POLL_INTERVAL_S = 0.005


class RegisterTransport(Protocol):
    """Reads and writes a WB-DALI module's Modbus registers."""

    async def read_input(self, device_id: str, address: int, count: int) -> List[int]: ...

    async def write_holding(self, device_id: str, address: int, values: List[int]) -> None: ...


class BlockingDaliDriver:
    """One DALI bus of one WB-DALI module."""

    def __init__(
        self,
        config: WBDALIConfig,
        transport: RegisterTransport,
        logger: logging.Logger,
        dev_inst_map: Optional[DeviceInstanceTypeMapper] = None,
    ) -> None:
        if config.bus not in (1, 2, 3):
            raise ValueError("Bus number must be 1, 2 or 3")

        self.config = config
        self.logger = logger.getChild(f"{config.device_name}_bus{config.bus}")
        self.dev_inst_map = dev_inst_map
        self.bus_traffic = BusTrafficCallbacks(QUEUE_SIZE)
        self.response_timeout = RESPONSE_TIMEOUT_S

        self._transport = transport
        # One transaction at a time: the whole point of this driver is that a
        # command and its answer are a single blocking exchange.
        self._lock = asyncio.Lock()
        self._slot = 0
        self._sequence_id = 0

    # -- lifecycle --------------------------------------------------------

    async def initialize(self) -> None:
        await self._reset_queue()

    async def deinitialize(self) -> None:
        return None

    async def _reset_queue(self) -> None:
        """Point the gateway back at slot 0 and drop anything not yet sent."""
        await self._transport.write_holding(
            self.config.device_name, queue_pointer_address(self.config.bus), [0]
        )
        self._slot = 0

    # -- sending ----------------------------------------------------------

    async def send(
        self,
        cmd: Command,
        source: BusTrafficSource = BusTrafficSource.WB,
        priority: FramePriority = FramePriority.USER_ACTION,
    ) -> Response:
        return (await self.send_commands([cmd], source, priority))[0]

    async def send_commands(
        self,
        commands: Sequence[Command],
        source: BusTrafficSource = BusTrafficSource.WB,
        priority: FramePriority = FramePriority.USER_ACTION,
    ) -> List[Response]:
        async with self._lock:
            return await self._send_commands(commands, source, priority)

    async def _send_commands(
        self,
        commands: Sequence[Command],
        source: BusTrafficSource,
        priority: FramePriority,
    ) -> List[Response]:
        # A device-type-specific command is only decodable after the
        # EnableDeviceType that precedes it, so the pair has to go out together.
        expanded: List[Command] = []
        for cmd in commands:
            if cmd.devicetype != 0:
                expanded.append(EnableDeviceType(cmd.devicetype))
            expanded.append(cmd)

        priorities = _compute_frame_priorities(expanded, priority)
        answers = [
            await self._transact(cmd, frame_priority, source)
            for cmd, frame_priority in zip(expanded, priorities)
        ]

        # Give back one response per command the caller asked for, dropping the
        # EnableDeviceType frames this method inserted.
        responses: List[Response] = []
        index = 0
        for cmd in commands:
            if cmd.devicetype != 0:
                index += 1
            responses.append(answers[index])
            index += 1
        return responses

    async def _transact(
        self, cmd: Command, priority: FramePriority, source: BusTrafficSource
    ) -> Response:
        response = await self._exchange(cmd, priority)
        self.bus_traffic.notify_command(cmd.frame, response, source, self._sequence_id)
        self._sequence_id += 1
        return response

    async def _exchange(self, cmd: Command, priority: FramePriority) -> Response:
        device_id = self.config.device_name
        bus = self.config.bus
        slot = self._slot
        self._slot = (slot + 1) % QUEUE_SIZE

        frame = cmd.frame
        value = encode_frame(frame.as_integer, len(frame), cmd.sendtwice, priority.value)

        try:
            await self._transport.write_holding(
                device_id, queue_slot_address(bus, slot), to_registers(value)
            )
            reply = await self._poll_reply(device_id, bus, slot)
        except Exception as error:  # pylint: disable=broad-exception-caught
            self.logger.error("DALI transaction failed: %s", error)
            return NoResponseFromGateway()

        if reply is None:
            self.logger.error("No reply for %s in slot %d", cmd, slot)
            return NoResponseFromGateway()
        return self._to_response(cmd, *decode_reply(reply))

    async def _poll_reply(self, device_id: str, bus: int, slot: int) -> Optional[int]:
        """Read the reply register until the gateway reports a transmission."""
        address = reply_address(bus, slot)
        deadline = asyncio.get_running_loop().time() + self.response_timeout
        while True:
            value = (await self._transport.read_input(device_id, address, 1))[0]
            if value >> 8 != TransmissionStatus.NO_TRANSMISSION:
                return value
            if asyncio.get_running_loop().time() >= deadline:
                return None
            await asyncio.sleep(POLL_INTERVAL_S)

    def _to_response(self, cmd: Command, status: TransmissionStatus, backward: int) -> Response:
        if status is TransmissionStatus.WITH_BACKWARD_RESPONSE:
            return cmd.response(BackwardFrame(backward)) if cmd.response else Response(None)
        if status is TransmissionStatus.WITHOUT_RESPONSE:
            return cmd.response(None) if cmd.response else Response(None)
        if status is TransmissionStatus.BROKEN_RESPONSE:
            # Several devices answered at once. For COMPARE during a bus scan
            # that is a "yes", which is why it is a response and not an error.
            return cmd.response(BackwardFrameError(backward)) if cmd.response else Response(None)
        if status is TransmissionStatus.NO_POWER_ON_BUS:
            return NoPowerOnBus()
        if status is TransmissionStatus.OVERHEAT:
            return Overheat()
        return NoTransmission()

    # -- sequences --------------------------------------------------------

    async def run_sequence(
        self,
        seq,
        priority: FramePriority = FramePriority.USER_ACTION,
        progress=None,
    ) -> Any:
        """Run a python-dali generator sequence to completion.

        The generator yields commands, lists of commands, `sleep` markers and
        `progress` markers, and expects the response to each command back. The
        whole sequence holds the bus, so nothing interleaves with it.
        """
        response: Union[Response, List[Response]] = Response(None)
        started = False
        try:
            async with self._lock:
                while True:
                    try:
                        cmd = next(seq) if not started else seq.send(response)
                        started = True
                    except StopIteration as stop:
                        return stop.value

                    response = Response(None)
                    if isinstance(cmd, seq_sleep):
                        await asyncio.sleep(cmd.delay)
                    elif isinstance(cmd, seq_progress):
                        if progress:
                            progress(cmd)
                    elif isinstance(cmd, list):
                        response = await self._send_commands(cmd, BusTrafficSource.WB, priority)
                    else:
                        response = (
                            await self._send_commands([cmd], BusTrafficSource.WB, priority)
                        )[0]
        finally:
            seq.close()


def make_driver_class(transport: RegisterTransport):
    """Bind a transport to a driver class the daemon can construct itself.

    `ApplicationController` builds its own driver, passing the MQTT dispatcher it
    would have used to reach wb-mqtt-serial. Substituting the name it constructs
    is the whole adaptation: the dispatcher argument is ignored, and the bus is
    reached through Modbus registers instead.
    """

    class _BoundDriver(BlockingDaliDriver):
        def __init__(self, config, _mqtt_dispatcher, logger, dev_inst_map=None):
            super().__init__(config, transport, logger, dev_inst_map)

    return _BoundDriver
