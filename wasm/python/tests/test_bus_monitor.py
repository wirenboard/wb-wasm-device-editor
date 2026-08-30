"""Reading traffic the gateway did not send.

The reply registers only ever answer our own frames. Anything else on the bus —
a DALI-2 button press, another master's command — reaches the daemon through the
gateway's four-slot monitor ring, which this polls.
"""

import asyncio

import pytest
from wb.mqtt_dali.bus_traffic import BusTrafficSource

from wbdali_browser.dali_driver import MONITOR_IDLE_POLL_INTERVAL_S, MONITOR_POLL_INTERVAL_S
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


async def test_the_ring_is_read_even_with_the_monitor_off(dali_logger):
    """A sensor's readings arrive as event frames; the daemon needs them whether
    or not anyone is watching the monitor view.

    An earlier version only polled while the operator's monitor toggle was on,
    and a DALI-2 sensor's illuminance stayed frozen at its boot value while
    its LightEvents scrolled past unseen.
    """
    switch = SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)
    stack = SimulatedStack(devices=[switch])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    try:
        frame = switch.press(0)
        stack.gateway.record_bus_frame(1, len(frame), frame.as_integer)

        frames = await collect_bus_frames(driver, MONITOR_IDLE_POLL_INTERVAL_S * 4)

        assert [item.request.as_integer for item in frames] == [frame.as_integer]
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


async def test_the_monitor_toggle_only_changes_the_pace(dali_logger):
    """Polling runs from initialize to deinitialize; the toggle picks the interval."""
    stack = SimulatedStack(devices=[SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)])
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    assert driver._monitor_task is not None  # pylint: disable=protected-access
    assert driver._monitor_interval == MONITOR_IDLE_POLL_INTERVAL_S  # pylint: disable=protected-access

    driver.set_bus_monitor_enabled(True)
    assert driver._monitor_interval == MONITOR_POLL_INTERVAL_S  # pylint: disable=protected-access
    driver.set_bus_monitor_enabled(False)
    assert driver._monitor_task is not None  # pylint: disable=protected-access
    assert driver._monitor_interval == MONITOR_IDLE_POLL_INTERVAL_S  # pylint: disable=protected-access

    await driver.deinitialize()
    assert driver._monitor_task is None  # pylint: disable=protected-access


async def test_a_bus_of_plain_gear_polls_the_ring_lazily(dali_logger):
    """No control devices — nothing speaks unprompted, the idle poll relaxes."""
    from wbdali_browser.dali_driver import MONITOR_QUIET_POLL_INTERVAL_S

    stack = SimulatedStack()
    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    try:
        driver.set_has_control_devices(False)
        assert driver._monitor_interval == MONITOR_QUIET_POLL_INTERVAL_S  # pylint: disable=protected-access

        # The operator's monitor toggle still wins while it is on…
        driver.set_bus_monitor_enabled(True)
        assert driver._monitor_interval == MONITOR_POLL_INTERVAL_S  # pylint: disable=protected-access
        driver.set_bus_monitor_enabled(False)
        assert driver._monitor_interval == MONITOR_QUIET_POLL_INTERVAL_S  # pylint: disable=protected-access

        # …and a sensor appearing after a rescan quickens the idle pace.
        driver.set_has_control_devices(True)
        assert driver._monitor_interval == MONITOR_IDLE_POLL_INTERVAL_S  # pylint: disable=protected-access
    finally:
        await driver.deinitialize()


async def test_frames_from_before_the_session_are_not_replayed(dali_logger):
    """A real module's ring still holds last session's frames at boot; the
    controller suppresses that snapshot via retained-drop, and so must we."""
    switch = SimulatedControlDevice(shortaddr=0, random_address=0x2B3C4D)
    stack = SimulatedStack(devices=[switch])
    stale = switch.press(0)
    stack.gateway.record_bus_frame(1, len(stale), stale.as_integer)

    driver = stack.driver(logger=dali_logger)
    await driver.initialize()
    driver.set_bus_monitor_enabled(True)
    try:
        assert await collect_bus_frames(driver, MONITOR_POLL_INTERVAL_S * 4) == []

        fresh = switch.press(0)
        stack.gateway.record_bus_frame(1, len(fresh), fresh.as_integer)
        frames = await collect_bus_frames(driver, MONITOR_POLL_INTERVAL_S * 4)
        assert [item.request.as_integer for item in frames] == [fresh.as_integer]
    finally:
        await driver.deinitialize()
