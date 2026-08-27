"""A virtual WB-DALI Modbus-to-DALI gateway.

Emulation happens at the Modbus register level, so everything above it is the
production code path: `WBDALIDriver` encodes frames and writes them into the
gateway's send queue exactly as it would over a real RS-485 link, and reads the
answers back out of the same reply registers.

Register map, taken from the WB-DALI device template shipped with
wb-mqtt-serial (`config-wb-dali.json`). Bus 2 and 3 repeat it at +1000 and
+2000:

| Registers   | Type    | Control id                        | Meaning                    |
| ----------- | ------- | --------------------------------- | -------------------------- |
| 1400..1431  | holding | —                                 | send queue, 16 slots × 2   |
| 1432        | holding | `bus_1_bulk_send_pointer`         | queue reset / read pointer |
| 1500..1515  | input   | `bus_1_bulk_send_reply_<0..15>`   | per-slot transmission result|
| 1900..1915  | input   | `bus_1_monitor_sporadic_frame_<1..4>` | bus monitor ring, 4 × u64 |

A bus monitor slot is a 64-bit value, `word_order: little_endian`:

    [63..48] frame counter, mod 2^16   [41] broken   [40] backward frame
    [39..32] frame length in bits      [24..0] frame data      0 = empty slot

Queue slots hold a 32-bit value in two registers, low word first:

    [24..0]  frame data, right-aligned      [27..25] frame size (0=FF16, 1=FF24, 2=FF25)
    [28]     send twice                     [31..29] priority (0 = do not send)

A reply register holds `status << 8 | backward_frame`.
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, Iterable, List, Optional

from .dali_bus import SimulatedDaliBus, TransmissionStatus

logger = logging.getLogger("wbdali_browser.sim.gateway")

BUS_ADDRESS_OFFSET = 1000
QUEUE_BASE = 1400
QUEUE_SIZE = 16
QUEUE_POINTER = 1432
REPLY_BASE = 1500
MONITOR_BASE = 1900
MONITOR_RING_SIZE = 4
MONITOR_REGISTERS_PER_SLOT = 4

FRAME_SIZE_BITS = {0: 16, 1: 24, 2: 25}

# The frame counter in a bus monitor slot is 16 bits wide.
FRAME_COUNTER_MODULO = 1 << 16

ReplyCallback = Callable[[int, int, int], None]
MonitorCallback = Callable[[int, int, int], None]


class DecodedSlot:
    """One queue slot, as the gateway firmware would read it."""

    __slots__ = ("frame", "bit_length", "sendtwice", "priority")

    def __init__(self, frame: int, bit_length: int, sendtwice: bool, priority: int) -> None:
        self.frame = frame
        self.bit_length = bit_length
        self.sendtwice = sendtwice
        self.priority = priority

    def __repr__(self) -> str:
        return (
            f"DecodedSlot(frame=0x{self.frame:06x}, bits={self.bit_length}, "
            f"sendtwice={self.sendtwice}, priority={self.priority})"
        )


def decode_queue_value(value: int) -> Optional[DecodedSlot]:
    """Decode a queue slot. Returns ``None`` for priority 0, which means "do not send"."""
    priority = (value >> 29) & 0x7
    if priority == 0:
        return None
    frame_size = (value >> 25) & 0x7
    bit_length = FRAME_SIZE_BITS.get(frame_size)
    if bit_length is None:
        logger.warning("Queue slot has unsupported frame size code %d", frame_size)
        return None
    mask = (1 << bit_length) - 1
    return DecodedSlot(
        frame=value & mask,
        bit_length=bit_length,
        sendtwice=bool(value & (1 << 28)),
        priority=priority,
    )


class VirtualBus:
    """The gateway's per-bus state: queue, reply slots and the monitor ring."""

    def __init__(self, index: int, dali_bus: SimulatedDaliBus) -> None:
        self.index = index
        self.dali_bus = dali_bus
        self.queue: List[int] = [0] * (QUEUE_SIZE * 2)
        self.replies: List[int] = [0] * QUEUE_SIZE
        self.monitor: List[int] = [0] * MONITOR_RING_SIZE
        self.monitor_write_index = 0
        self.frame_counter = 0

    @property
    def address_offset(self) -> int:
        return (self.index - 1) * BUS_ADDRESS_OFFSET


class VirtualWbDaliGateway:
    """A WB-DALI module with three DALI buses, addressed over Modbus.

    :param buses: mapping of bus number (1..3) to the simulated DALI bus behind it
    :param on_reply: called as ``(bus, slot, value)`` whenever a reply register
        changes — the emulated wb-mqtt-serial turns this into an MQTT publish
    :param on_monitor: called as ``(bus, slot, value)`` for the bus monitor ring
    """

    def __init__(
        self,
        buses: Dict[int, SimulatedDaliBus],
        on_reply: Optional[ReplyCallback] = None,
        on_monitor: Optional[MonitorCallback] = None,
    ) -> None:
        self.buses: Dict[int, VirtualBus] = {
            index: VirtualBus(index, bus) for index, bus in buses.items()
        }
        self.on_reply = on_reply
        self.on_monitor = on_monitor
        self.monitor_enabled: Dict[int, bool] = {index: False for index in self.buses}
        self.reachable = True
        self.frames_sent = 0

    # -- Modbus -----------------------------------------------------------

    def write_holding(self, address: int, values: Iterable[int]) -> None:
        values = list(values)
        bus = self._bus_for(address)
        if bus is None:
            logger.debug("Write to unmapped holding register %d", address)
            return

        local = address - bus.address_offset
        if local == QUEUE_POINTER:
            # wb-mqtt-dali writes 0 here to resynchronise the queue after a
            # gateway restart; the firmware drops anything not yet transmitted.
            bus.queue = [0] * (QUEUE_SIZE * 2)
            return

        if QUEUE_BASE <= local < QUEUE_BASE + QUEUE_SIZE * 2:
            first_register = local - QUEUE_BASE
            for offset, value in enumerate(values):
                if first_register + offset < len(bus.queue):
                    bus.queue[first_register + offset] = value & 0xFFFF
            self._transmit(bus, first_register // 2, len(values) // 2)
            return

        logger.debug("Write to unhandled holding register %d", address)

    def read_holding(self, address: int, count: int) -> List[int]:
        bus = self._bus_for(address)
        if bus is None:
            return [0] * count
        local = address - bus.address_offset
        if QUEUE_BASE <= local < QUEUE_BASE + QUEUE_SIZE * 2:
            start = local - QUEUE_BASE
            return (bus.queue + [0] * count)[start : start + count]
        return [0] * count

    def read_input(self, address: int, count: int) -> List[int]:
        bus = self._bus_for(address)
        if bus is None:
            return [0] * count
        local = address - bus.address_offset
        result = []
        for offset in range(count):
            result.append(self._read_input_register(bus, local + offset))
        return result

    def _read_input_register(self, bus: VirtualBus, local: int) -> int:
        if REPLY_BASE <= local < REPLY_BASE + QUEUE_SIZE:
            return bus.replies[local - REPLY_BASE]
        if MONITOR_BASE <= local < MONITOR_BASE + MONITOR_RING_SIZE * MONITOR_REGISTERS_PER_SLOT:
            slot, word = divmod(local - MONITOR_BASE, MONITOR_REGISTERS_PER_SLOT)
            # u64, little_endian word order: the least significant word first.
            return (bus.monitor[slot] >> (16 * word)) & 0xFFFF
        return 0

    def _bus_for(self, address: int) -> Optional[VirtualBus]:
        index = (address - QUEUE_BASE) // BUS_ADDRESS_OFFSET + 1
        return self.buses.get(index)

    # -- transmission -----------------------------------------------------

    def _transmit(self, bus: VirtualBus, first_slot: int, slot_count: int) -> None:
        for offset in range(slot_count):
            slot = first_slot + offset
            if slot >= QUEUE_SIZE:
                break
            low = bus.queue[slot * 2]
            high = bus.queue[slot * 2 + 1]
            decoded = decode_queue_value((high << 16) | low)
            if decoded is None:
                continue
            self._send_one(bus, slot, decoded)

    def _send_one(self, bus: VirtualBus, slot: int, decoded: DecodedSlot) -> None:
        # A send-twice command goes out as two identical frames on the wire, but
        # it is one command: a real ballast acts only once, on the second frame.
        # The simulated units model the command, so deliver it once and let the
        # bus monitor see both frames.
        status, backward = bus.dali_bus.send_frame(decoded.frame, decoded.bit_length)
        self.frames_sent += 2 if decoded.sendtwice else 1

        value = (int(status) << 8) | (backward & 0xFF)
        bus.replies[slot] = value
        if self.on_reply is not None:
            self.on_reply(bus.index, slot, value)

    def push_monitor_frame(
        self,
        bus_index: int,
        bit_length: int,
        frame: int,
        backward: bool = False,
        broken: bool = False,
    ) -> None:
        """Record one frame in the bus monitor ring.

        Only traffic the gateway did not originate belongs here — the control
        name is `monitor_sporadic_frame`, and the driver already sees its own
        commands and their answers through the reply registers. Echoing them
        would double every line in the monitor.
        """
        bus = self.buses.get(bus_index)
        if bus is None or not self.monitor_enabled.get(bus_index):
            return

        bus.frame_counter = (bus.frame_counter + 1) % FRAME_COUNTER_MODULO
        value = (
            (bus.frame_counter << 48)
            | (int(broken) << 41)
            | (int(backward) << 40)
            | ((bit_length & 0xFF) << 32)
            | (frame & 0x1FFFFFF)
        )
        slot = bus.monitor_write_index
        bus.monitor[slot] = value
        bus.monitor_write_index = (slot + 1) % MONITOR_RING_SIZE
        if self.on_monitor is not None:
            self.on_monitor(bus_index, slot, value)
