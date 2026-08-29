"""The blocking DALI driver against the simulated gateway.

This is the load-bearing test of the whole design: one command written into a
queue slot, one reply register polled for the answer, and nothing in between.
Everything above the driver — commissioning, device parameters, the Editor RPC —
is unchanged production code, so if this holds, that does too.
"""

import asyncio

from dali.address import GearBroadcast, GearShort
from dali.gear.general import DAPC, Off, QueryActualLevel, QueryControlGearPresent

from wb.mqtt_dali.wbdali_error_response import NoResponseFromGateway

from wbdali_browser.registers import (
    TransmissionStatus,
    encode_frame,
    queue_slot_address,
    to_registers,
)

from wbdali_browser.sim.control_gear import SimulatedControlGear as simulated_gear

from .conftest import SimulatedStack


async def make_driver(stack, logger, bus: int = 1):
    driver = stack.driver(bus=bus, logger=logger)
    await driver.initialize()
    return driver


async def test_query_reaches_the_gear_and_the_answer_comes_back(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    try:
        await driver.send(DAPC(GearShort(0), 200))
        response = await driver.send(
            QueryActualLevel(GearShort(0))
        )

        assert response.value == 200
        assert stack.buses[1].gear[0].level == 200
    finally:
        await driver.deinitialize()


async def test_command_without_an_answer_completes(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    try:
        response = await driver.send(
            Off(GearBroadcast())
        )

        assert response.raw_value is None
        assert stack.buses[1].gear[0].level == 0
    finally:
        await driver.deinitialize()


async def test_each_answer_in_a_batch_lands_on_its_own_command(stack, dali_logger):
    """A batch goes out one frame at a time; the answers must not get crossed."""
    driver = await make_driver(stack, dali_logger)
    try:
        await driver.send_commands(
            [DAPC(GearShort(0), 10), DAPC(GearShort(1), 20)]
        )
        responses = await driver.send_commands(
            [QueryActualLevel(GearShort(0)), QueryActualLevel(GearShort(1))]
        )

        assert [response.value for response in responses] == [10, 20]
    finally:
        await driver.deinitialize()


async def test_query_to_an_empty_address_reports_no_answer(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    try:
        response = await driver.send(
            QueryControlGearPresent(GearShort(40))
        )

        assert response.raw_value is None
    finally:
        await driver.deinitialize()


async def test_an_unwired_bus_is_silent(stack, dali_logger):
    """Buses 2 and 3 of the module exist but have no gear on them."""
    driver = await make_driver(stack, dali_logger, bus=2)
    try:
        response = await driver.send(
            QueryControlGearPresent(GearShort(0))
        )

        assert response.raw_value is None
    finally:
        await driver.deinitialize()


async def test_a_long_run_of_commands_keeps_answering(dali_logger):
    """Twenty commands through the one slot the driver reuses for every frame.

    Each reuses slot 0, whose reply register still holds the previous answer
    until the write clears it — and on a populated bus that answer is usually
    identical, so nothing here could be caught by comparing values.
    """
    stack = SimulatedStack(
        gear=[simulated_gear(shortaddr=index, random_address=0x1000 + index) for index in range(20)]
    )
    await stack.start()
    try:
        driver = await make_driver(stack, dali_logger)
        try:
            responses = await driver.send_commands(
                [QueryControlGearPresent(GearShort(index)) for index in range(20)]
            )

            assert len(responses) == 20
            assert all(response.value for response in responses)
        finally:
            await driver.deinitialize()
    finally:
        await stack.stop()


async def test_a_module_that_stops_answering_modbus_does_not_hang_the_caller(stack, dali_logger):
    """The Modbus request itself fails, before any reply polling."""
    driver = await make_driver(stack, dali_logger)
    try:
        stack.gateway.reachable = False

        response = await asyncio.wait_for(driver.send(QueryActualLevel(GearShort(0))), timeout=2.0)

        assert isinstance(response, NoResponseFromGateway)
    finally:
        await driver.deinitialize()


async def test_a_gateway_that_never_transmits_gives_up_on_the_frame(stack, dali_logger):
    """A reply register stuck at "no transmission" must not be polled forever."""
    driver = await make_driver(stack, dali_logger)
    driver.response_timeout = 0.2
    # Accept the write but never transmit, which is what a wedged queue looks like.
    stack.gateway.buses[1].dali_bus.send_frame = lambda *_: (TransmissionStatus.NO_TRANSMISSION, 0)
    try:
        started = asyncio.get_running_loop().time()
        response = await asyncio.wait_for(driver.send(QueryActualLevel(GearShort(0))), timeout=5.0)
        elapsed = asyncio.get_running_loop().time() - started

        assert isinstance(response, NoResponseFromGateway)
        assert 0.2 <= elapsed < 2.0
    finally:
        await driver.deinitialize()


async def test_a_module_that_comes_back_answers_again(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    driver.response_timeout = 0.2
    try:
        stack.gateway.reachable = False
        assert isinstance(await driver.send(QueryActualLevel(GearShort(0))), NoResponseFromGateway)

        stack.gateway.reachable = True
        assert (await driver.send(QueryActualLevel(GearShort(0)))).value == 0
    finally:
        await driver.deinitialize()


async def test_repeating_a_query_gets_a_fresh_answer_each_time(stack, dali_logger):
    """Consecutive identical answers must not look like a stale reply register.

    The driver relies on the gateway clearing a reply register when its queue
    slot is written, so an answer that happens to equal the previous one is
    still recognised as this frame's. Without that it would have to compare
    values, and identical answers are the norm.
    """
    driver = await make_driver(stack, dali_logger)
    try:
        await driver.send(DAPC(GearShort(0), 42))
        for _ in range(4):
            assert (await driver.send(QueryActualLevel(GearShort(0)))).value == 42
    finally:
        await driver.deinitialize()


async def test_the_gateway_will_not_reach_past_its_pointer(stack, dali_logger):
    """A frame armed beyond the consume pointer stays put.

    Measured on a real WB-DALI: with the pointer at 0, a frame written into
    slot 5 sat there unsent and the pointer never moved. The simulator models
    that, so the stall a slot-counting driver eventually walks into is
    reproducible here rather than only against hardware.
    """
    driver = await make_driver(stack, dali_logger)
    try:
        bus = stack.gateway.buses[1]
        assert bus.pointer == 0
        # Arm slot 5 directly, the way a driver whose counter had drifted would.
        frame = encode_frame(QueryControlGearPresent(GearBroadcast()).frame.as_integer, 16, False, 2)
        stack.gateway.write_holding(queue_slot_address(1, 5), to_registers(frame))

        assert bus.pointer == 0, "the gateway must wait at its pointer"
        assert bus.replies[5] == 0, "and report nothing for the slot it has not reached"
    finally:
        await driver.deinitialize()


async def test_a_frame_goes_out_whatever_the_pointer_was(stack, dali_logger):
    """The driver rewinds, so no earlier state can leave it stalled.

    This is the property that made the round-robin version fail on hardware:
    once its counter ran ahead of the firmware's pointer, every later frame was
    parked out of reach until the counter wrapped, which showed up as bursts of
    consecutive one-second timeouts.
    """
    driver = await make_driver(stack, dali_logger)
    try:
        for stale_pointer in (0, 5, 15):
            stack.gateway.buses[1].pointer = stale_pointer
            response = await driver.send(QueryControlGearPresent(GearShort(0)))
            assert response.value is True, f"stalled with the pointer at {stale_pointer}"
    finally:
        await driver.deinitialize()


async def test_a_batch_is_one_write_and_one_bulk_read(stack, dali_logger):
    """The whole point of batching: Modbus overhead amortised across the queue.

    Ten commands must not cost ten writes and ten polled reads — one rewind,
    one fc16 carrying every frame, a poll on the last slot, one bulk read.
    """

    class CountingTransport:
        def __init__(self, inner):
            self.inner = inner
            self.writes = []
            self.reads = []

        async def read_input(self, device_id, address, count):
            self.reads.append((address, count))
            return await self.inner.read_input(device_id, address, count)

        async def write_holding(self, device_id, address, values):
            self.writes.append((address, len(values)))
            await self.inner.write_holding(device_id, address, values)

    transport = CountingTransport(stack.network)
    driver = stack.driver(bus=1, logger=dali_logger, transport=transport)
    await driver.initialize()
    try:
        transport.writes.clear()
        transport.reads.clear()
        responses = await driver.send_commands(
            [QueryControlGearPresent(GearShort(0)) for _ in range(10)]
        )

        assert all(response.value for response in responses)
        # One pointer rewind (1 register) plus one batch write (20 registers).
        assert transport.writes == [(1432, 1), (1400, 20)]
        # Polls of the last slot's reply, then one 10-register bulk read.
        assert transport.reads[-1] == (1500, 10)
        assert all(read == (1509, 1) for read in transport.reads[:-1])
    finally:
        await driver.deinitialize()
