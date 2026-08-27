"""Reading traffic the gateway did not send.

The reply registers only ever answer our own frames. Anything else on the bus —
a DALI-2 button press, another master's command — reaches the daemon through the
gateway's four-slot monitor ring, which this polls.
"""

import asyncio

import pytest
from wb.mqtt_dali.bus_traffic import BusTrafficSource

from wbdali_browser.dali_driver import MONITOR_POLL_INTERVAL_S
from wbdali_browser.sim.control_gear import SimulatedControlDevice

from .conftest import GATEWAY_DEVICE_ID, SimulatedStack


async def collect_bus_frames(driver, seconds: float):
    seen = []
    unregister = driver.bus_traffic.register(seen.append)
    try:
        await asyncio.sleep(seconds)
    finally:
        unregister()
    return [item for item in seen if item.request_source is BusTrafficSource.BUS]


async def test_a_button_press_reaches_the_daemon(dali_logger):
    switch = SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)
    stack = SimulatedStack(devices=[switch])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    driver.set_bus_monitor_enabled(True)
    try:
        frame = switch.press(0)
        stack.gateway.record_bus_frame(1, len(frame), frame.as_integer)

        frames = await collect_bus_frames(driver, MONITOR_POLL_INTERVAL_S * 4)

        assert [item.request.as_integer for item in frames] == [frame.as_integer]
    finally:
        await driver.deinitialize()


async def test_nothing_is_read_while_the_monitor_is_off(dali_logger):
    """The ring costs serial traffic, so it is only read when asked for."""
    switch = SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)
    stack = SimulatedStack(devices=[switch])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    try:
        frame = switch.press(0)
        stack.gateway.record_bus_frame(1, len(frame), frame.as_integer)

        assert await collect_bus_frames(driver, MONITOR_POLL_INTERVAL_S * 3) == []
    finally:
        await driver.deinitialize()


async def test_a_frame_is_reported_once(dali_logger):
    """A ring slot keeps its value until the ring wraps onto it again."""
    switch = SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)
    stack = SimulatedStack(devices=[switch])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    driver.set_bus_monitor_enabled(True)
    try:
        frame = switch.press(0)
        stack.gateway.record_bus_frame(1, len(frame), frame.as_integer)

        frames = await collect_bus_frames(driver, MONITOR_POLL_INTERVAL_S * 6)

        assert len(frames) == 1
    finally:
        await driver.deinitialize()


async def test_the_gateways_own_frames_do_not_appear_twice(dali_logger):
    """A command and its answer come back through the reply register.

    Recording them in the ring as well would double every line in the monitor,
    which is why `record_bus_frame` is only for traffic from elsewhere.
    """
    from dali.address import GearBroadcast
    from dali.gear.general import Off

    from wbdali_browser.sim.control_gear import SimulatedControlGear

    stack = SimulatedStack(gear=[SimulatedControlGear(shortaddr=0, random_address=0x1A2B3C)])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    driver.set_bus_monitor_enabled(True)
    try:
        await driver.send(Off(GearBroadcast()))

        assert await collect_bus_frames(driver, MONITOR_POLL_INTERVAL_S * 3) == []
    finally:
        await driver.deinitialize()


async def test_turning_the_monitor_off_stops_the_polling(dali_logger):
    stack = SimulatedStack(devices=[SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()

    driver.set_bus_monitor_enabled(True)
    assert driver._monitor_task is not None  # pylint: disable=protected-access
    driver.set_bus_monitor_enabled(False)
    assert driver._monitor_task is None  # pylint: disable=protected-access

    await driver.deinitialize()
