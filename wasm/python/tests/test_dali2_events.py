"""Attributing DALI-2 event frames to the device that sent them.

The daemon can only credit an event to a device when the frame itself names
one: of the five addressing schemes in IEC 62386-103 Table 8, that is the
"Device/Instance" scheme (short address + instance number, with the instance
type looked up in the map built during device init). A sensor left in the
factory-default "Instance" scheme sends frames that decode fine — the monitor
shows LightEvent(I1, 422) — but name no device, so the daemon drops them and
the Illuminance control stays frozen at 0. The cure is the sensor's own
"Event addressing scheme" setting, which the settings panel exposes.
"""

import asyncio

from dali.tests import fakes

from wbdali_browser.runtime import DaliRuntime, default_config
from wbdali_browser.sim.control_gear import SimulatedControlDevice
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.network import SimulatedModbusNetwork

from .conftest import GATEWAY_DEVICE_ID, serial_config_with
from .test_memory_cache import VENDOR_DIR

# LightEvent(instance 1, 422 lux) as an MSensor in the factory "Instance"
# scheme puts it on the wire — instance type 4 in the frame, no short address.
LIGHT_EVENT_INSTANCE_SCHEME = 0x8885A6
# The same reading from the same sensor after switching instance 1 to the
# "Device/Instance" scheme — short address 0 and instance number 1 in the frame.
LIGHT_EVENT_DEVICE_INSTANCE_SCHEME = 0x0085A6


class SimulatedSensor(SimulatedControlDevice):
    # occupancy (type 3) + light (type 4), reported to init so the daemon's
    # instance map learns that (short 0, instance 1) is a light sensor
    _instances = [
        fakes.Device.Instance(inst_type=3, scheme=2),
        fakes.Device.Instance(inst_type=4, scheme=2),
    ]


async def sensor_runtime(tmp_path):
    config = default_config([GATEWAY_DEVICE_ID])
    config["gateways"][0]["buses"][0]["devices"] = [
        {"short": 0, "random": 0x2BB6F8, "name": "sensor", "dali2": True},
    ]
    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_device(SimulatedSensor(shortaddr=0, random_address=0x2BB6F8))
    network.add_module(GATEWAY_DEVICE_ID, buses)
    runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=config,
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await runtime.start()
    return runtime, network


async def published_after_frame(runtime, network, raw):
    seen = []
    runtime.subscribe(
        f"/devices/{GATEWAY_DEVICE_ID}_bus_1_dali2_0/controls/#",
        lambda topic, payload, retained: seen.append((topic.rsplit("/", 1)[-1], payload, retained)),
    )
    await asyncio.sleep(0.5)
    network.gateways[GATEWAY_DEVICE_ID].record_bus_frame(1, 24, raw)
    await asyncio.sleep(2)
    return [(control, payload) for control, payload, retained in seen if not retained]


async def test_a_device_instance_scheme_event_updates_the_control(tmp_path):
    runtime, network = await sensor_runtime(tmp_path)
    try:
        published = await published_after_frame(runtime, network, LIGHT_EVENT_DEVICE_INSTANCE_SCHEME)
        assert ("illuminance1", "422") in published
    finally:
        await runtime.stop()


async def test_an_instance_scheme_event_names_no_device_and_is_dropped(tmp_path):
    runtime, network = await sensor_runtime(tmp_path)
    try:
        published = await published_after_frame(runtime, network, LIGHT_EVENT_INSTANCE_SCHEME)
        assert published == []
    finally:
        await runtime.stop()
