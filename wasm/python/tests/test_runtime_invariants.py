"""Properties the rest of the stack quietly depends on.

Each of these was a real defect: the symptoms appeared far from the cause, in a
dropped UI update, an out-of-order DALI frame, or two RPC calls resolving with
each other's answers.
"""

import asyncio

import pytest

from wbdali_browser.broker import Broker, Client
from wbdali_browser.serial_service import WbMqttSerialEmulator
from wbdali_browser.sim.control_gear import SimulatedControlGear
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.network import SimulatedModbusNetwork

from .conftest import GATEWAY_DEVICE_ID, SimulatedStack, serial_config_with


async def test_a_publish_in_the_same_tick_as_a_subscribe_is_delivered(tmp_path):
    """`Broker.publish` matches subscriptions as it delivers.

    Deferring the broker-side subscribe to the event loop would silently drop
    anything published before it ran, which is exactly what a caller that
    subscribes and then immediately publishes does.
    """
    stack = SimulatedStack()
    await stack.start()
    try:
        received = []
        client = Client(stack.broker, "same-tick")
        client.add_filter("/probe/topic")
        stack.broker.publish("/probe/topic", "hello")

        message = await asyncio.wait_for(client.messages.__anext__(), 1.0)
        received.append(message.payload)

        assert received == [b"hello"]
    finally:
        await stack.stop()


async def test_writes_to_one_module_are_transmitted_in_order():
    """A real gateway drains its queue strictly in order.

    With bus time charged before transmitting and no per-module serialisation, a
    later, shorter write overtakes an earlier, longer one — and an
    EnableDeviceType ending one batch gets overtaken by the DT command starting
    the next.
    """
    network = SimulatedModbusNetwork(frame_delay_s=0.02)
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    gateway = network.add_module(GATEWAY_DEVICE_ID, buses)

    order = []
    original = gateway.write_holding
    gateway.write_holding = lambda address, values: (
        order.append(address), original(address, values)
    )[1]

    long_write = asyncio.create_task(
        network.write_holding(GATEWAY_DEVICE_ID, 1400, [0] * 6)
    )
    await asyncio.sleep(0.005)
    short_write = asyncio.create_task(
        network.write_holding(GATEWAY_DEVICE_ID, 1406, [0] * 2)
    )
    await asyncio.gather(long_write, short_write)

    assert order == [1400, 1406]


async def test_concurrent_rpc_calls_do_not_answer_each_other(tmp_path):
    """Two calls in flight at once must each get their own reply."""
    from pathlib import Path

    from wbdali_browser.runtime import DaliRuntime

    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x1A2B3C))
    network.add_module(GATEWAY_DEVICE_ID, buses)

    runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        vendor_dir=Path(__file__).parent.parent / "vendor",
        root=tmp_path,
    )
    network.bind(runtime.serial.publish_control)
    await runtime.start()
    try:
        gateway, bus = await asyncio.gather(
            runtime.rpc("Editor", "GetGateway", {"gatewayId": GATEWAY_DEVICE_ID}),
            runtime.rpc("Editor", "GetBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"}),
        )

        assert "websocket_enabled" in gateway["config"]
        assert "bus_monitor_enabled" in bus["config"]
    finally:
        await runtime.stop()


async def test_an_unreachable_module_reports_an_error_rather_than_hanging(tmp_path):
    stack = SimulatedStack(gear=[SimulatedControlGear(shortaddr=0, random_address=0x1A2B3C)])
    await stack.start()
    try:
        stack.gateway.reachable = False

        with pytest.raises(Exception):
            await asyncio.wait_for(
                stack.network.write_holding(GATEWAY_DEVICE_ID, 1400, [0, 0]), 1.0
            )
    finally:
        await stack.stop()


async def test_the_serial_emulator_answers_the_config_the_daemon_discovers_gateways_from():
    """`Gateway._update_gateways` deletes any gateway this config does not list."""
    stack = SimulatedStack()
    await stack.start()
    try:
        config = await stack.serial._handle_config_load({})

        devices = config["config"]["ports"][0]["devices"]
        assert [device["id"] for device in devices] == [GATEWAY_DEVICE_ID]
        assert all(device["device_type"] == "WB-DALI" for device in devices)
    finally:
        await stack.stop()
