"""The whole stack, driven through the RPC surface the web UI actually calls.

`Editor/GetList` and `Editor/ScanBus` are what the DALI page issues when it
opens and when the operator scans a bus. Everything under them here is the
production daemon.
"""

import asyncio
import json
from pathlib import Path

from wbdali_browser.runtime import DaliRuntime, default_config
from wbdali_browser.sim.control_gear import SimulatedControlGear
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.network import SimulatedModbusNetwork

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
