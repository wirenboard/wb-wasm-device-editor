"""A virtual WB-DALI Modbus-to-DALI gateway.

Emulation happens at the Modbus register level, so everything above it is the
production code path: frames are encoded into the send queue and answers read
back out of the reply registers exactly as they are on a real module.

The register map lives in :mod:`wbdali_browser.registers`, shared with the
driver.
"""

from __future__ import annotations

import logging
from typing import Dict, Iterable, List, Optional

from ..registers import (
    BUS_ADDRESS_OFFSET,
    FRAME_COUNTER_MODULO,
    MONITOR_BASE,
    MONITOR_REGISTERS_PER_SLOT,
    MONITOR_RING_SIZE,
    QUEUE_BASE,
    QUEUE_POINTER,
    QUEUE_SIZE,
    REPLY_BASE,
    decode_frame,
    encode_monitor_slot,
    encode_reply,
    from_registers,
    to_monitor_registers,
)
from .dali_bus import SimulatedDaliBus

logger = logging.getLogger("wbdali_browser.sim.gateway")


class VirtualBus:
    """The gateway's per-bus state: the send queue and its reply slots."""

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

    :param buses: bus number (1..3) mapped to the simulated DALI bus behind it
    """

    def __init__(self, buses: Dict[int, SimulatedDaliBus]) -> None:
        self.buses: Dict[int, VirtualBus] = {
            index: VirtualBus(index, bus) for index, bus in buses.items()
        }
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
            # The driver writes 0 here to resynchronise: anything not yet
            # transmitted is dropped, and its answers become meaningless.
            bus.queue = [0] * (QUEUE_SIZE * 2)
            bus.replies = [0] * QUEUE_SIZE
            return

        if QUEUE_BASE <= local < QUEUE_BASE + QUEUE_SIZE * 2:
            first_register = local - QUEUE_BASE
            for offset, value in enumerate(values):
                if first_register + offset < len(bus.queue):
                    bus.queue[first_register + offset] = value & 0xFFFF
            self._transmit(bus, first_register // 2, max(1, len(values) // 2))
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
        return [self._read_input_register(bus, local + offset) for offset in range(count)]

    def _read_input_register(self, bus: VirtualBus, local: int) -> int:
        if REPLY_BASE <= local < REPLY_BASE + QUEUE_SIZE:
            return bus.replies[local - REPLY_BASE]
        if MONITOR_BASE <= local < MONITOR_BASE + MONITOR_RING_SIZE * MONITOR_REGISTERS_PER_SLOT:
            slot, word = divmod(local - MONITOR_BASE, MONITOR_REGISTERS_PER_SLOT)
            return to_monitor_registers(bus.monitor[slot])[word]
        return 0

    def _bus_for(self, address: int) -> Optional[VirtualBus]:
        return self.buses.get((address - QUEUE_BASE) // BUS_ADDRESS_OFFSET + 1)

    # -- transmission -----------------------------------------------------

    def _transmit(self, bus: VirtualBus, first_slot: int, slot_count: int) -> None:
        for offset in range(slot_count):
            slot = first_slot + offset
            if slot >= QUEUE_SIZE:
                break
            # Writing a slot invalidates its previous answer: until the frame
            # goes out there is nothing to report for it.
            bus.replies[slot] = 0
            decoded = decode_frame(from_registers(bus.queue[slot * 2 : slot * 2 + 2]))
            if decoded is None:
                continue
            self._send_one(bus, slot, decoded)

    # -- bus monitor ------------------------------------------------------

    def record_bus_frame(
        self, bus_index: int, bit_length: int, frame: int, backward: bool = False
    ) -> None:
        """Put a frame the gateway did not send into the monitor ring.

        Only traffic from elsewhere on the bus belongs here — a control device's
        event, another master's command. The gateway's own frames and their
        answers already reach the daemon through the reply registers, and
        recording them again would double every line in the monitor.

        The ring is four slots deep, so a burst faster than the driver polls it
        overwrites the oldest. The daemon notices: it tracks the frame counter
        and reports a gap.
        """
        bus = self.buses.get(bus_index)
        if bus is None:
            return
        bus.frame_counter = (bus.frame_counter + 1) % FRAME_COUNTER_MODULO
        bus.monitor[bus.monitor_write_index] = encode_monitor_slot(
            bus.frame_counter, bit_length, frame, backward=backward
        )
        bus.monitor_write_index = (bus.monitor_write_index + 1) % MONITOR_RING_SIZE

    def _send_one(self, bus: VirtualBus, slot: int, decoded) -> None:
        frame, bit_length, sendtwice, _priority = decoded
        # A send-twice command goes out as two identical frames on the wire, but
        # it is one command: a real ballast acts only once, on the second frame.
        status, backward = bus.dali_bus.send_frame(frame, bit_length)
        self.frames_sent += 2 if sendtwice else 1
        bus.replies[slot] = encode_reply(status, backward)
