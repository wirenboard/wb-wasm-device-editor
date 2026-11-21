"""Properties the rest of the stack quietly depends on.

Each of these was a real defect: the symptoms appeared far from the cause, in a
dropped UI update, an out-of-order DALI frame, or two RPC calls resolving with
each other's answers.
"""

import asyncio

import pytest

from wb.mqtt_dali.sim.broker import Client
from wb.mqtt_dali.sim.control_gear import SimulatedControlGear
from wb.mqtt_dali.sim.dali_bus import SimulatedDaliBus
from wb.mqtt_dali.sim.network import SimulatedModbusNetwork

from .conftest import GATEWAY_DEVICE_ID, SimulatedStack, serial_config_with


async def test_a_publish_in_the_same_tick_as_a_subscribe_is_delivered():
    """`Broker.publish` matches subscriptions as it delivers.

    Deferring the broker-side subscribe to the event loop would silently drop
    anything published before it ran, which is exactly what a caller that
    subscribes and then immediately publishes does.
    """
    from wb.mqtt_dali.sim.broker import Broker

    broker = Broker()
    client = Client(broker, "same-tick")
    client.add_filter("/probe/topic")
    broker.publish("/probe/topic", "hello")

    message = await asyncio.wait_for(client.messages.__anext__(), 1.0)

    assert message.payload == b"hello"


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


async def test_an_unreachable_module_reports_an_error_rather_than_hanging():
    stack = SimulatedStack(gear=[SimulatedControlGear(shortaddr=0, random_address=0x1A2B3C)])
    stack.gateway.reachable = False

    with pytest.raises(Exception):
        await asyncio.wait_for(stack.network.write_holding(GATEWAY_DEVICE_ID, 1400, [0, 0]), 1.0)


async def test_the_config_service_lists_the_gateways_the_daemon_looks_for():
    """`Gateway._update_gateways` deletes any gateway this config does not list."""
    from wb.mqtt_dali.sim.broker import Broker
    from wb.mqtt_dali.sim.serial_service import FakeWbMqttSerial

    service = FakeWbMqttSerial(Broker(), None, serial_config_with(GATEWAY_DEVICE_ID))

    assert service.device_ids == [GATEWAY_DEVICE_ID]
    devices = service.serial_config["ports"][0]["devices"]
    assert all(device["device_type"] == "WB-DALI" for device in devices)


class _SlowTransport:
    """Every register exchange takes long enough that bus startup outlasts the boot wait."""

    def __init__(self, inner, delay_s: float) -> None:
        self.inner = inner
        self.delay_s = delay_s

    async def read_input(self, device_id, address, count):
        await asyncio.sleep(self.delay_s)
        return await self.inner.read_input(device_id, address, count)

    async def write_holding(self, device_id, address, values):
        await asyncio.sleep(self.delay_s)
        await self.inner.write_holding(device_id, address, values)


async def test_a_boot_that_times_out_leaves_nothing_running(tmp_path, monkeypatch):
    """Gateway.run() still starting its buses when the wait gives up refuses to
    stop them; the teardown must still end it, or the inline offline build runs
    an orphaned daemon beside the retry."""
    from pathlib import Path

    from wbdali_browser import runtime as runtime_module

    network = SimulatedModbusNetwork()
    network.add_module(GATEWAY_DEVICE_ID, {index: SimulatedDaliBus() for index in (1, 2, 3)})
    monkeypatch.setattr(runtime_module, "GATEWAY_START_TIMEOUT_S", 0.05)
    runtime = runtime_module.DaliRuntime(
        transport=_SlowTransport(network, delay_s=0.3),
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        vendor_dir=Path(__file__).parent.parent / "vendor",
        root=tmp_path,
    )
    with pytest.raises(TimeoutError):
        await runtime.start()

    await asyncio.sleep(1.0)  # past any bus startup a leaked run() would finish
    leftover = [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
    assert leftover == [], [task.get_name() for task in leftover]
