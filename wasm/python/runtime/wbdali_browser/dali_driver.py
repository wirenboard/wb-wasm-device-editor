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

The protocol rests on one firmware behaviour: **writing a queue slot clears its
reply register until the frame has been transmitted**, so a non-zero status
means "this frame's answer" rather than the previous one's. Measured on a real
WB-DALI: the slot reads back 0 immediately after the write and takes its status
a few milliseconds later, before the consume pointer has necessarily advanced.
Nothing else clears it — not a pointer reset, and not the passage of time — so a
slot that was never written keeps a stale status indefinitely, and the driver
must not read a reply it did not just arm by writing that slot.

Every frame goes into slot 0, after rewinding the gateway's consume pointer to
it. The gateway transmits armed slots strictly in index order and stops at the
pointer: measured on hardware, arming slot 5 while the pointer sits at 0 leaves
the frame there indefinitely, and it only goes out once slots 0..4 have been
consumed in turn. So a driver that picks slots by its own counter has to keep
that counter in lockstep with the firmware's pointer forever, and nothing
restores the invariant once it breaks — one dropped frame leaves every later
write parked ahead of the pointer, stalling until the counter wraps all the way
round. That failure is not hypothetical: it showed up on real hardware as bursts
of consecutive one-second timeouts that healed after roughly sixteen frames.

Rewinding before each frame is self-synchronising instead — the invariant is
re-established rather than assumed, so no earlier failure can persist. It is
safe because the firmware clears a slot as it consumes it, so a rewind cannot
re-send anything: rewinding onto an already-consumed slot transmits nothing and
leaves the reply register untouched. The cost is a third Modbus transaction per
frame, about a millisecond against a DALI frame's thirty-five.
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
from wb.mqtt_dali.overheat_rate_limiter import OverheatRateLimiter
from wb.mqtt_dali.wbdali import BusMonitorFrameHandler
from wb.mqtt_dali.wbdali import FramePriority, WBDALIConfig, _compute_frame_priorities
from wb.mqtt_dali.wbdali_error_response import (
    NoPowerOnBus,
    NoResponseFromGateway,
    NoTransmission,
    Overheat,
)

from .registers import (
    MONITOR_REGISTERS_PER_SLOT,
    MONITOR_RING_SIZE,
    QUEUE_SIZE,
    TransmissionStatus,
    decode_reply,
    encode_frame,
    from_monitor_registers,
    monitor_address,
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

# The queue slot every frame is written to, after rewinding the pointer onto it.
SEND_SLOT = 0

# How often to read the bus monitor ring while it is switched on.
#
# The ring holds four frames, so anything arriving faster than this is
# overwritten before it can be read — the daemon spots the gap in the frame
# counter and says so. Reading it competes with DALI traffic for the one serial
# link, which is why it is off unless the operator asks for it.
MONITOR_POLL_INTERVAL_S = 0.1


class RegisterTransport(Protocol):
    """Reads and writes a WB-DALI module's Modbus registers."""

    async def read_input(self, device_id: str, address: int, count: int) -> List[int]: ...

    async def write_holding(self, device_id: str, address: int, values: List[int]) -> None: ...


class _MonitorSlotMessage:  # pylint: disable=too-few-public-methods
    """One monitor ring slot, shaped the way `BusMonitorFrameHandler` reads it.

    On a controller these reach the handler as MQTT messages published by
    wb-mqtt-serial; here they come off a register read, and only `topic`,
    `payload` and `retain` are ever looked at.
    """

    __slots__ = ("topic", "payload", "retain")

    def __init__(self, bus: int, slot: int, raw: int) -> None:
        self.topic = f"bus_{bus}_monitor_sporadic_frame_{slot + 1}"
        self.payload = str(raw).encode()
        self.retain = False


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
        self._overheat = OverheatRateLimiter()
        # One transaction at a time: the whole point of this driver is that a
        # command and its answer are a single blocking exchange.
        self._lock = asyncio.Lock()
        self._sequence_id = 0
        self._monitor_task: Optional[asyncio.Task] = None

    # -- lifecycle --------------------------------------------------------

    async def initialize(self) -> None:
        await self._reset_queue()

    async def deinitialize(self) -> None:
        self.set_bus_monitor_enabled(False)

    async def _reset_queue(self) -> None:
        """Point the gateway back at slot 0."""
        await self._transport.write_holding(
            self.config.device_name, queue_pointer_address(self.config.bus), [0]
        )

    # -- bus monitor ------------------------------------------------------

    def set_bus_monitor_enabled(self, enabled: bool) -> None:
        """Start or stop reading the gateway's bus monitor ring.

        This is the only way traffic the gateway did not send — a DALI-2 button
        press, another master's command — reaches the daemon: the reply
        registers only ever answer our own frames.
        """
        if enabled == (self._monitor_task is not None):
            return
        if enabled:
            self._monitor_task = asyncio.create_task(
                self._poll_bus_monitor(), name=f"dali-monitor-{self.config.device_name}"
            )
            return
        self._monitor_task.cancel()
        self._monitor_task = None

    async def _poll_bus_monitor(self) -> None:
        handler = BusMonitorFrameHandler(self.bus_traffic, self.logger, self.dev_inst_map)
        # A slot keeps its value until the ring wraps onto it again, so the
        # previous read is what tells a new frame from one already reported.
        seen: List[Optional[int]] = [None] * MONITOR_RING_SIZE
        base = monitor_address(self.config.bus, 0)
        count = MONITOR_RING_SIZE * MONITOR_REGISTERS_PER_SLOT

        while True:
            await asyncio.sleep(MONITOR_POLL_INTERVAL_S)
            try:
                async with self._lock:
                    registers = await self._transport.read_input(
                        self.config.device_name, base, count
                    )
            except asyncio.CancelledError:
                raise
            except Exception as error:  # pylint: disable=broad-exception-caught
                self.logger.warning("Reading the bus monitor failed: %s", error)
                continue

            for slot in range(MONITOR_RING_SIZE):
                words = registers[
                    slot * MONITOR_REGISTERS_PER_SLOT : (slot + 1) * MONITOR_REGISTERS_PER_SLOT
                ]
                raw = from_monitor_registers(words)
                if raw == 0 or raw == seen[slot]:
                    continue
                seen[slot] = raw
                # The daemon's own handler does the decoding, the reordering by
                # frame counter and the gap reporting; it wants a message-shaped
                # carrier because on a controller these arrive over MQTT.
                handler.handle(_MonitorSlotMessage(self.config.bus, slot, raw))

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
        frame = cmd.frame
        value = encode_frame(frame.as_integer, len(frame), cmd.sendtwice, priority.value)

        # A module that has reported overheating needs to be left alone for a
        # while; the daemon's poll and retry loops would otherwise hammer it.
        await self._overheat.wait_before_send()

        try:
            # Rewind first: the gateway only ever transmits the slot its pointer
            # is on, so this is what guarantees the frame goes out at all.
            await self._reset_queue()
            await self._transport.write_holding(
                device_id, queue_slot_address(bus, SEND_SLOT), to_registers(value)
            )
            reply = await self._poll_reply(device_id, bus, SEND_SLOT)
        except Exception as error:  # pylint: disable=broad-exception-caught
            self.logger.error("DALI transaction failed: %s", error)
            return NoResponseFromGateway()

        if reply is None:
            self.logger.error("No reply for %s", cmd)
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
            self._overheat.on_overheat()
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
