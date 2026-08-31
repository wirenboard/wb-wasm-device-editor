"""Remembering settings-shaped answers, not just memory banks.

A device page open is mostly scene tables and DT8 colour values — around 190
frames per lamp at ~46 ms each — and none of it changes unless somebody
configures the device. The memo answers the second session's reads; a config
write (send-twice command) makes it forget what it remembered for that target.
"""

import asyncio
import collections
import tempfile
from pathlib import Path

from .test_memory_cache import boot, make_stack


async def _frames_of_get_device(network, buses, memory=None):
    counts = collections.Counter()
    orig = buses[1]._deliver  # pylint: disable=protected-access
    def counting(cmd, bit_length):
        counts[type(cmd).__name__] += 1
        return orig(cmd, bit_length)
    buses[1]._deliver = counting  # pylint: disable=protected-access
    with tempfile.TemporaryDirectory() as tmp:
        runtime = await boot(Path(tmp), network, memory=memory)
        try:
            gateways = await runtime.rpc("Editor", "GetList")
            device_id = gateways[0]["buses"][0]["devices"][0]["id"]
            counts.clear()  # boot traffic is not what this measures
            await runtime.rpc("Editor", "GetDevice", {"deviceId": device_id})
            snapshot = runtime.snapshot_memory()
        finally:
            await runtime.stop()
    return counts, snapshot


async def test_a_seeded_session_reads_scenes_and_levels_off_the_memo():
    network, buses = make_stack()
    cold, memory = await _frames_of_get_device(network, buses)
    assert cold["QuerySceneLevel"] > 0
    assert cold["QueryPowerOnLevel"] > 0

    network2, buses2 = make_stack()
    seeded, _ = await _frames_of_get_device(network2, buses2, memory=memory)
    # Scene tables and the plain (device-type-0) level queries are remembered;
    # the DT8 colour reads deliberately are not (their answers are split
    # between the frame and the device's DTR0 — see memory_cache._SETTINGS),
    # and the DTR/EnableDeviceType ceremony always goes out.
    assert seeded["QuerySceneLevel"] == 0
    assert seeded["QueryPowerOnLevel"] == 0
    assert seeded["QueryColourValue"] == cold["QueryColourValue"]
    assert sum(seeded.values()) < sum(cold.values())


async def test_a_seeded_sensor_page_reads_its_instances_off_the_memo():
    """A DALI-2 device page is per-instance settings and feature probes —
    the second session should ask the bus almost none of it."""
    import collections

    from .test_dali2_events import GATEWAY_DEVICE_ID as SENSOR_GW  # noqa: F401
    from . import test_dali2_events as ev

    # Build the sensor stack the dali2-events tests use.
    import tempfile
    from pathlib import Path

    from wbdali_browser.runtime import DaliRuntime, default_config
    from wb.mqtt_dali.sim.dali_bus import SimulatedDaliBus
    from wb.mqtt_dali.sim.network import SimulatedModbusNetwork

    async def one_session(memory=None):
        config = default_config([SENSOR_GW])
        config["gateways"][0]["buses"][0]["devices"] = [
            {"short": 0, "random": 0x2BB6F8, "name": "sensor", "dali2": True},
        ]
        network = SimulatedModbusNetwork()
        buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
        buses[1].add_device(ev.SimulatedSensor(shortaddr=0, random_address=0x2BB6F8))
        network.add_module(SENSOR_GW, buses)
        counts = collections.Counter()
        orig = buses[1]._deliver  # pylint: disable=protected-access
        def counting(cmd, bit_length):
            counts[type(cmd).__name__] += 1
            return orig(cmd, bit_length)
        buses[1]._deliver = counting  # pylint: disable=protected-access
        with tempfile.TemporaryDirectory() as tmp:
            runtime = DaliRuntime(
                transport=network,
                serial_config={"ports": [{"path": "/dev/x", "enabled": True,
                    "devices": [{"id": SENSOR_GW, "slave_id": 17, "device_type": "WB-DALI", "enabled": True}]}]},
                config=config, vendor_dir=Path("vendor"), root=Path(tmp), memory=memory)
            await runtime.start()
            try:
                gateways = await runtime.rpc("Editor", "GetList")
                device_id = gateways[0]["buses"][0]["devices"][0]["id"]
                counts.clear()
                await runtime.rpc("Editor", "GetDevice", {"deviceId": device_id})
                snapshot = runtime.snapshot_memory()
            finally:
                await runtime.stop()
        return counts, snapshot

    cold, memory = await one_session()
    seeded, _ = await one_session(memory=memory)
    assert cold["QueryEventScheme"] > 0
    assert seeded["QueryEventScheme"] == 0
    assert sum(seeded.values()) < sum(cold.values()) / 2
