"""Identity read off the bus once: the memory-bank memo.

Every device initialization re-reads memory banks 0 and 1 — GTIN, serials,
versions — dozens of frames per device whose answers cannot change. The memo
in the driver answers them from the previous session, after the device has
confirmed its random address on the wire.
"""

import asyncio
import json
from pathlib import Path

from dali.address import GearShort
from dali.gear.general import Initialise

from wbdali_browser.runtime import DaliRuntime, default_config
from wbdali_browser.sim.control_gear import SimulatedControlGear
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.network import SimulatedModbusNetwork

from .conftest import GATEWAY_DEVICE_ID, serial_config_with

VENDOR_DIR = Path(__file__).parent.parent / "vendor"
BUS_ID = f"{GATEWAY_DEVICE_ID}_bus_1"
RANDOM = 0x123456


def make_stack(random_address=RANDOM):
    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=random_address, devicetypes=[8]))
    network.add_module(GATEWAY_DEVICE_ID, buses)
    return network, buses


def configured(random_address=RANDOM):
    config = default_config([GATEWAY_DEVICE_ID])
    config["gateways"][0]["buses"][0]["devices"] = [
        {"short": 0, "random": random_address, "name": "lamp"},
    ]
    return config


async def boot(tmp_path, network, memory=None):
    runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=configured(),
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
        groups={f"{GATEWAY_DEVICE_ID}_bus_1_0": []},
        memory=memory,
    )
    await runtime.start()
    return runtime


async def identity(runtime):
    gateways = await runtime.rpc("Editor", "GetList")
    device_id = gateways[0]["buses"][0]["devices"][0]["id"]
    data = await runtime.rpc("Editor", "GetDevice", {"deviceId": device_id})
    config = data["config"]
    return {key: config.get(key) for key in ("gtin", "identification_number", "firmware_version", "hardware_version")}


async def test_a_seeded_second_session_reads_identity_without_the_bus(tmp_path):
    """Boot once cold, snapshot; boot again seeded — same identity, a fraction of the frames."""
    network, buses = make_stack()
    bus = buses[1]

    first = await boot(tmp_path / "a", network)
    try:
        before = bus.frames_seen
        cold = await identity(first)  # the banks are read on the first device-page open
        cold_frames = bus.frames_seen - before
        snapshot = first.snapshot_memory()
    finally:
        await first.stop()

    assert BUS_ID in snapshot and snapshot[BUS_ID]["gear"], "the memo must have learned the banks"
    assert snapshot[BUS_ID]["gear"]["0"]["random"] == RANDOM
    memory = json.loads(json.dumps(snapshot))  # the persistence round trip

    second = await boot(tmp_path / "b", network, memory=memory)
    try:
        before = bus.frames_seen
        warm = await identity(second)
        warm_frames = bus.frames_seen - before
    finally:
        await second.stop()

    assert warm == cold
    assert warm["gtin"], "identity must actually be populated"
    assert warm_frames < cold_frames / 2, f"seeded boot still cost {warm_frames} of {cold_frames} frames"


async def test_a_memo_for_a_device_that_was_swapped_is_dropped(tmp_path):
    """Same short address, different random address: the bus wins, the memo goes."""
    network, buses = make_stack()
    first = await boot(tmp_path / "a", network)
    try:
        snapshot = first.snapshot_memory()
    finally:
        await first.stop()

    # A different lamp now sits at short address 0 — and it must be its
    # identity that shows up, byte for byte from the wire.
    swapped_network, swapped_buses = make_stack(random_address=0x654321)
    second = await boot(tmp_path / "b", swapped_network, memory=snapshot)
    try:
        before = swapped_buses[1].frames_seen
        result = await identity(second)
        seen = swapped_buses[1].frames_seen - before
        assert result["gtin"]
        assert seen > 30, "a dropped memo must mean the banks were read from the bus"
        resnapshot = second.snapshot_memory()
        assert resnapshot[BUS_ID]["gear"]["0"]["random"] == 0x654321
    finally:
        await second.stop()


async def test_recommissioning_forgets_the_bus(tmp_path):
    """INITIALISE means short addresses may change hands: the memo for that bus is dropped."""
    network, _buses = make_stack()
    runtime = await boot(tmp_path, network)
    try:
        await identity(runtime)  # the banks are read on the first device-page open
        assert runtime.snapshot_memory()[BUS_ID]["gear"]
        cache = runtime.memory_caches[(GATEWAY_DEVICE_ID, 1)]
        cache.observe(Initialise(GearShort(0)), None)
        assert not runtime.snapshot_memory()[BUS_ID]["gear"]
    finally:
        await runtime.stop()
