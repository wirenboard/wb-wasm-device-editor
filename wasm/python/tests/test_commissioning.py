"""The production commissioning algorithm against the simulated bus.

`Editor/ScanBus` in the web UI runs exactly this code: the binary search over
random addresses, short-address assignment, and the withdraw pass. Getting it to
find the simulated gear proves the simulation is faithful where it matters most
— nothing else in the daemon exercises the DALI protocol as hard.
"""

import asyncio

from wb.mqtt_dali.commissioning import Commissioning, CommissioningStage
from wb.mqtt_dali.dali_device import DaliDeviceAddress

from wb.mqtt_dali.sim.control_gear import SimulatedControlGear as simulated_gear

from .conftest import SimulatedStack


async def run_commissioning(stack, logger, old_devices=(), progress_cb=None):
    driver = stack.driver(logger=logger)
    await driver.initialize()
    try:
        commissioning = Commissioning(driver, list(old_devices), False, progress_cb)
        return await asyncio.wait_for(commissioning.smart_extend(), timeout=120)
    finally:
        await driver.deinitialize()


async def test_unaddressed_gear_gets_short_addresses(dali_logger):
    """A fresh bus: three drivers with no short address, found by binary search."""
    stack = SimulatedStack(
        gear=[
            simulated_gear(random_address=0x000010),
            simulated_gear(random_address=0x400000),
            simulated_gear(random_address=0xAB1234),
        ]
    )
    await stack.start()
    try:
        result = await run_commissioning(stack, dali_logger)

        assigned = sorted(unit.shortaddr for unit in stack.buses[1].gear)
        assert assigned == [0, 1, 2]
        assert sorted(device.random for device in result.new) == [0x000010, 0x400000, 0xAB1234]
        assert result.missing == []
    finally:
        await stack.stop()


async def test_already_addressed_gear_keeps_its_addresses(dali_logger):
    """A rescan of a known bus must not readdress anything."""
    gear = [
        simulated_gear(shortaddr=0, random_address=0x000010),
        simulated_gear(shortaddr=5, random_address=0x400000),
    ]
    stack = SimulatedStack(gear=gear)
    await stack.start()
    try:
        # Give the simulated gear the random addresses a previous scan left behind.
        first = await run_commissioning(stack, dali_logger)
        known = [DaliDeviceAddress(short, random) for short, random in first_addresses(first)]

        second = await run_commissioning(stack, dali_logger, old_devices=known)

        assert [unit.shortaddr for unit in stack.buses[1].gear] == [0, 5]
        assert second.new == []
        assert second.missing == []
        assert sorted(device.short for device in second.unchanged) == [0, 5]
    finally:
        await stack.stop()


def first_addresses(result):
    return [(device.short, device.random) for device in result.new + result.unchanged]


async def test_a_removed_device_is_reported_missing(dali_logger):
    stack = SimulatedStack(
        gear=[
            simulated_gear(shortaddr=0, random_address=0x000010),
            simulated_gear(shortaddr=1, random_address=0x400000),
        ]
    )
    await stack.start()
    try:
        first = await run_commissioning(stack, dali_logger)
        known = [DaliDeviceAddress(short, random) for short, random in first_addresses(first)]

        removed = stack.buses[1].gear.pop()
        result = await run_commissioning(stack, dali_logger, old_devices=known)

        assert [device.random for device in result.missing] == [removed.randomaddr.as_integer]
        assert [device.short for device in result.unchanged] == [0]
    finally:
        await stack.stop()


async def test_an_empty_bus_finds_nothing(dali_logger):
    stack = SimulatedStack()
    await stack.start()
    try:
        result = await run_commissioning(stack, dali_logger)

        assert result.new == []
        assert result.unchanged == []
        assert result.missing == []
    finally:
        await stack.stop()


async def test_progress_is_reported_monotonically(dali_logger):
    reports = []

    stack = SimulatedStack(
        gear=[simulated_gear(random_address=0x000010 * (index + 1)) for index in range(3)]
    )
    await stack.start()
    try:
        await run_commissioning(
            stack,
            dali_logger,
            progress_cb=lambda stage, percent, found: reports.append((stage, percent, found)),
        )

        assert reports, "commissioning reported no progress at all"
        percentages = [percent for _stage, percent, _found in reports]
        assert percentages == sorted(percentages)
        assert percentages[0] == 0
        assert max(percentages) >= 50
        assert sum(1 for _stage, _percent, found in reports if found) == 3
        assert reports[-1][0] is CommissioningStage.BINARY_SEARCH
    finally:
        await stack.stop()
