"""The whole stack, driven through the RPC surface the web UI actually calls.

`Editor/GetList` and `Editor/ScanBus` are what the DALI page issues when it
opens and when the operator scans a bus. Everything under them here is the
production daemon.
"""

import asyncio
import json
from pathlib import Path

from wbdali_browser.runtime import DaliRuntime, default_config
from wb.mqtt_dali.sim.control_gear import SimulatedControlGear
from wb.mqtt_dali.sim.dali_bus import SimulatedDaliBus
from wb.mqtt_dali.sim.network import SimulatedModbusNetwork

from .conftest import GATEWAY_DEVICE_ID, serial_config_with

VENDOR_DIR = Path(__file__).parent.parent / "vendor"


async def make_runtime(tmp_path, gear=()):
    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    for unit in gear:
        buses[1].add_gear(unit)
    network.add_module(GATEWAY_DEVICE_ID, buses)

    runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=default_config([GATEWAY_DEVICE_ID]),
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await runtime.start()
    runtime.buses = buses
    return runtime


async def test_get_list_returns_the_gateway_tree(tmp_path):
    runtime = await make_runtime(tmp_path)
    try:
        gateways = await runtime.rpc("Editor", "GetList")

        assert [gateway["id"] for gateway in gateways] == [GATEWAY_DEVICE_ID]
        buses = gateways[0]["buses"]
        assert [bus["id"] for bus in buses] == [f"{GATEWAY_DEVICE_ID}_bus_{n}" for n in (1, 2, 3)]
        assert all(bus["devices"] == [] for bus in buses)
        assert buses[0]["commissioning"]["status"] == "idle"
    finally:
        await runtime.stop()


async def test_get_bus_and_gateway_return_config_and_schema(tmp_path):
    runtime = await make_runtime(tmp_path)
    try:
        bus = await runtime.rpc("Editor", "GetBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})
        gateway = await runtime.rpc("Editor", "GetGateway", {"gatewayId": GATEWAY_DEVICE_ID})

        assert bus["config"] == {"bus_monitor_enabled": False, "bus_monitor_syslog_enabled": False}
        assert gateway["config"]["websocket_enabled"] is False
        assert "websocket_port" in gateway["config"]
    finally:
        await runtime.stop()


async def test_scan_bus_finds_the_simulated_gear(tmp_path):
    """The operator's "scan" button, end to end, including the progress topic."""
    runtime = await make_runtime(
        tmp_path,
        gear=[
            SimulatedControlGear(random_address=0x000010),
            SimulatedControlGear(random_address=0x400000),
        ],
    )
    progress = []
    runtime.subscribe(
        f"/wb-dali/{GATEWAY_DEVICE_ID}_bus_1/commissioning",
        lambda _topic, payload, _retain: progress.append(json.loads(payload)) if payload else None,
    )
    try:
        started = await runtime.rpc("Editor", "ScanBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})
        assert started["status"] == "started"
        assert started["progressTopic"] == f"/wb-dali/{GATEWAY_DEVICE_ID}_bus_1/commissioning"

        await wait_for_commissioning(progress)

        assert progress[-1]["status"] == "completed"
        assert progress[-1]["device_count"] == 2
        assert sorted(unit.shortaddr for unit in runtime.buses[1].gear) == [0, 1]

        gateways = await runtime.rpc("Editor", "GetList")
        devices = gateways[0]["buses"][0]["devices"]
        assert len(devices) == 2
        assert all(device["id"] and device["name"] for device in devices)
    finally:
        await runtime.stop()


async def test_a_completed_scan_is_written_to_the_config_file(tmp_path):
    runtime = await make_runtime(tmp_path, gear=[SimulatedControlGear(random_address=0x123456)])
    progress = []
    runtime.subscribe(
        f"/wb-dali/{GATEWAY_DEVICE_ID}_bus_1/commissioning",
        lambda _topic, payload, _retain: progress.append(json.loads(payload)) if payload else None,
    )
    try:
        await runtime.rpc("Editor", "ScanBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})
        await wait_for_commissioning(progress)

        written = json.loads((tmp_path / "etc/wb-mqtt-dali.conf").read_text())
        devices = written["gateways"][0]["buses"][0]["devices"]
        assert devices == [{"short": 0, "random": 0x123456}]
    finally:
        await runtime.stop()


async def test_scanning_a_bus_twice_at_once_is_refused(tmp_path):
    runtime = await make_runtime(tmp_path, gear=[SimulatedControlGear(random_address=0x123456)])
    try:
        first = await runtime.rpc("Editor", "ScanBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})
        second = await runtime.rpc("Editor", "ScanBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})

        assert first["status"] == "started"
        assert second["status"] == "already_running"
    finally:
        await runtime.stop()


async def wait_for_commissioning(progress, timeout: float = 120.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    terminal = {"completed", "failed", "cancelled"}
    while asyncio.get_running_loop().time() < deadline:
        if progress and progress[-1]["status"] in terminal:
            return
        await asyncio.sleep(0.05)
    raise TimeoutError(f"commissioning did not finish; last state {progress[-1:]}")


class _SerialPacedTransport:
    """A register transport that takes real time, like a serial link does.

    The simulated network answers within one task step, which lets the daemon
    finish initializing its devices before anything else gets to run — so a
    boot-order race that shows on hardware every time can never show against
    it. A small sleep per operation is enough to lose that race reliably.
    """

    def __init__(self, network):
        self._network = network

    async def read_input(self, device_id, address, count):
        await asyncio.sleep(0.002)
        return await self._network.read_input(device_id, address, count)

    async def write_holding(self, device_id, address, values):
        await asyncio.sleep(0.002)
        await self._network.write_holding(device_id, address, values)


async def test_groups_survive_a_restart_without_a_rescan(tmp_path):
    """The first GetList of a fresh boot already carries group membership.

    The web UI takes its device tree from one GetList when the page mounts and
    only rebuilds it from a commissioning run. Group membership is not in the
    config file — it lives on the gear, read during device initialization — so
    boot must not report ready before that read has happened, or every session
    opens showing the installation without its groups until someone rescans.
    """
    config = default_config([GATEWAY_DEVICE_ID])
    config["gateways"][0]["buses"][0]["devices"] = [
        {"short": 0, "random": 0x100000, "name": "grouped lamp"},
    ]

    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x100000, groups={1, 5}))
    network.add_module(GATEWAY_DEVICE_ID, buses)

    runtime = DaliRuntime(
        transport=_SerialPacedTransport(network),
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=config,
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await runtime.start()
    try:
        gateways = await runtime.rpc("Editor", "GetList")

        devices = gateways[0]["buses"][0]["devices"]
        assert [device["name"] for device in devices] == ["grouped lamp"]
        assert devices[0]["groups"] == [1, 5]
    finally:
        await runtime.stop()


async def test_seeded_groups_show_without_waiting_for_the_bus(tmp_path):
    """A groups seed makes the first GetList correct with no init wait at all.

    The seed is what the previous session saw; boot applies it before the page
    can ask, then skips the init wait for seeded devices — so opening the page
    is fast, and initialization corrects the state from the bus behind it.
    """
    config = default_config([GATEWAY_DEVICE_ID])
    config["gateways"][0]["buses"][0]["devices"] = [
        {"short": 0, "random": 0x100000, "name": "grouped lamp"},
    ]

    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    # The bus says groups {1, 5}; the seed deliberately says {2} so the test
    # can tell which one the first snapshot came from.
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x100000, groups={1, 5}))
    network.add_module(GATEWAY_DEVICE_ID, buses)

    runtime = DaliRuntime(
        transport=_SerialPacedTransport(network),
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=config,
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
        groups={f"{GATEWAY_DEVICE_ID}_bus_1_0": [2]},
    )
    await runtime.start()
    try:
        gateways = await runtime.rpc("Editor", "GetList")
        devices = gateways[0]["buses"][0]["devices"]
        assert devices[0]["groups"] == [2], "the first snapshot must come from the seed"

        # And the bus remains the authority: once initialization has read the
        # gear, the daemon's state is the measured membership, not the seed.
        for _ in range(200):
            await asyncio.sleep(0.05)
            snapshot = runtime.snapshot_groups()
            if snapshot.get(f"{GATEWAY_DEVICE_ID}_bus_1_0") == [1, 5]:
                break
        else:
            raise AssertionError(f"init never corrected the seed: {runtime.snapshot_groups()}")
    finally:
        await runtime.stop()


async def test_scan_all_buses_commissions_a_fresh_gateway_by_itself(tmp_path):
    """The first open of an unconfigured gateway scans every bus unprompted.

    This is what browser.start() kicks off in the background when the config
    holds no devices at all: sequential scans, bus by bus, through the same
    Editor/ScanBus surface the Rescan button uses — so the page sees ordinary
    commissioning traffic and needs nothing special.
    """
    runtime = await make_runtime(
        tmp_path,
        gear=[
            SimulatedControlGear(random_address=0x000010),
            SimulatedControlGear(random_address=0x400000),
        ],
    )
    try:
        assert runtime.installation_is_fresh()

        await runtime.scan_all_buses()

        gateways = await runtime.rpc("Editor", "GetList")
        buses = gateways[0]["buses"]
        assert len(buses[0]["devices"]) == 2
        assert buses[1]["devices"] == []
        assert buses[2]["devices"] == []
        assert not runtime.installation_is_fresh()
    finally:
        await runtime.stop()


async def test_a_configured_installation_is_not_fresh(tmp_path):
    """One known device anywhere means no automatic scan."""
    config = default_config([GATEWAY_DEVICE_ID])
    config["gateways"][0]["buses"][0]["devices"] = [
        {"short": 0, "random": 0x100000, "name": "lamp"},
    ]

    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x100000))
    network.add_module(GATEWAY_DEVICE_ID, buses)

    runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=config,
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await runtime.start()
    try:
        assert not runtime.installation_is_fresh()
    finally:
        await runtime.stop()


async def test_the_config_watcher_reports_groups_learned_after_boot(tmp_path):
    """Membership read off the bus behind the page still gets persisted.

    Device initialization changes no file and answers no RPC, so the watcher
    listens on the device topics the daemon publishes as it initializes; a
    subscription that never fires would leave the persisted seed stale forever,
    re-applied on every reload.
    """
    config = default_config([GATEWAY_DEVICE_ID])
    config["gateways"][0]["buses"][0]["devices"] = [
        {"short": 0, "random": 0x100000, "name": "grouped lamp"},
    ]

    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x100000, groups={1, 5}))
    network.add_module(GATEWAY_DEVICE_ID, buses)

    runtime = DaliRuntime(
        transport=_SerialPacedTransport(network),
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config=config,
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
        # A stale seed skips the boot wait; the bus says {1, 5}.
        groups={f"{GATEWAY_DEVICE_ID}_bus_1_0": [2]},
    )
    await runtime.start()
    try:
        reports = []
        runtime.watch_config(lambda config_text, groups_json, _memory: reports.append(json.loads(groups_json)))

        for _ in range(200):
            await asyncio.sleep(0.05)
            if any(report.get(f"{GATEWAY_DEVICE_ID}_bus_1_0") == [1, 5] for report in reports):
                break
        else:
            raise AssertionError(f"watcher never reported the corrected groups: {reports[-3:]}")
    finally:
        await runtime.stop()
