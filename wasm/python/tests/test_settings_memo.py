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
    # The signature also includes the DTR state: a preceding DTR write makes
    # this a different question than the one learned, and a miss goes to the
    # wire — over-keyed on purpose, never wrong.
    assert cache.plan([DTR0(200), QuerySceneLevel(GearShort(0), 7)]) is None


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
