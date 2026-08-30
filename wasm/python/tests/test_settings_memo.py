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

from dali.address import GearBroadcast, GearShort
from dali.frame import BackwardFrame
from dali.gear.general import DTR0, QuerySceneLevel, SetMaxLevel

from wbdali_browser.memory_cache import MemoryCache

from .test_memory_cache import boot, make_stack


class _Answer:  # pylint: disable=too-few-public-methods
    def __init__(self, byte):
        self.raw_value = BackwardFrame(byte)


def test_a_config_write_makes_the_memo_forget_its_target():
    cache = MemoryCache()
    query = QuerySceneLevel(GearShort(0), 7)
    cache.observe(query, _Answer(42))
    assert cache.plan([query]) == {0: 42}

    # A config write to another short leaves this device's memo alone…
    cache.observe(SetMaxLevel(GearShort(3)), None)
    assert cache.plan([query]) == {0: 42}

    # …a write to this short — or to everyone — does not.
    cache.observe(SetMaxLevel(GearShort(0)), None)
    assert cache.plan([query]) is None

    cache.observe(query, _Answer(42))
    cache.observe(SetMaxLevel(GearBroadcast()), None)
    assert cache.plan([query]) is None


def test_a_batch_containing_a_config_write_is_never_served():
    cache = MemoryCache()
    query = QuerySceneLevel(GearShort(0), 7)
    cache.observe(query, _Answer(42))
    assert cache.plan([query, SetMaxLevel(GearShort(0))]) is None


def test_the_signature_tells_scenes_apart():
    cache = MemoryCache()
    cache.observe(QuerySceneLevel(GearShort(0), 7), _Answer(42))
    assert cache.plan([QuerySceneLevel(GearShort(0), 8)]) is None
    # The signature is the question itself, not the surrounding traffic: an
    # unrelated DTR write earlier in the batch must not turn the same scene
    # question into a different one (interleaved generators write DTRs all
    # the time).
    assert cache.plan([DTR0(200), QuerySceneLevel(GearShort(0), 7)]) == {1: 42}


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


def test_a_transient_no_answer_is_not_remembered():
    cache = MemoryCache()
    query = QuerySceneLevel(GearShort(0), 7)

    class _NoAnswer:  # pylint: disable=too-few-public-methods
        raw_value = None

    cache.observe(query, _NoAnswer())
    assert cache.plan([query]) is None

    # The next, answered read is what the memo keeps.
    cache.observe(query, _Answer(42))
    assert cache.plan([query]) == {0: 42}


def test_an_undelivered_read_does_not_advance_the_shadow_register():
    from dali.gear.general import DTR1, ReadMemoryLocation

    cache = MemoryCache()

    class _Undelivered:  # pylint: disable=too-few-public-methods
        raw_value = None

    cache.observe(DTR1(0), None)
    cache.observe(DTR0(3), None)
    # The gateway never transmitted this frame — the device never saw it,
    # so its DTR0 still points at offset 3.
    cache.observe(ReadMemoryLocation(GearShort(0)), _Undelivered(), delivered=False)
    cache.observe(ReadMemoryLocation(GearShort(0)), _Answer(0x42))

    assert cache.plan([DTR1(0), DTR0(3), ReadMemoryLocation(GearShort(0))]) == {2: 0x42}


def test_per_instance_questions_do_not_collide():
    from dali.address import DeviceShort, InstanceNumber
    from dali.device.general import QueryEventScheme

    cache = MemoryCache()
    q1 = QueryEventScheme(DeviceShort(0), InstanceNumber(1))
    q2 = QueryEventScheme(DeviceShort(0), InstanceNumber(2))
    cache.observe(q1, _Answer(2))
    assert cache.plan([q1]) == {0: 2}
    # Instance 2 was never asked — its answer must not be instance 1's.
    assert cache.plan([q2]) is None


def test_absence_is_remembered_only_with_three_strikes_of_conviction():
    from dali.address import DeviceShort
    from wb.mqtt_dali.device.feedback import QueryFeedbackCapability
    from dali.address import FeatureInstanceNumber

    class _NoAnswer:  # pylint: disable=too-few-public-methods
        raw_value = None

    cache = MemoryCache()
    probe = QueryFeedbackCapability(DeviceShort(0), FeatureInstanceNumber(2))

    cache.observe(probe, _NoAnswer())
    cache.observe(probe, _NoAnswer())
    assert cache.plan([probe]) is None  # two glitches are not a fact

    cache.observe(probe, _NoAnswer())
    # Three consecutive unanswered deliveries: the device does not implement
    # this feature, and the memo now answers the probe without the bus.
    assert cache.plan([probe]) == {0: None}

    # An actual answer resets the conviction counter.
    cache2 = MemoryCache()
    cache2.observe(probe, _NoAnswer())
    cache2.observe(probe, _Answer(1))
    cache2.observe(probe, _NoAnswer())
    cache2.observe(probe, _NoAnswer())
    assert cache2.plan([probe]) == {0: 1}


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
    from wbdali_browser.sim.dali_bus import SimulatedDaliBus
    from wbdali_browser.sim.network import SimulatedModbusNetwork

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
