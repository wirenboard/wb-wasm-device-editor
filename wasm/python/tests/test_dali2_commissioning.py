"""Discovering DALI-2 control devices — wall switches and sensors.

`Editor/ScanBus` runs two passes: control gear on 16-bit frames, then control
devices on 24-bit ones. python-dali's fake control device models instances, DTRs
and memory banks but no addressing at all, so before this the input-device half
of every scan came back empty.
"""

import asyncio
import json
from pathlib import Path

import pytest

from wbdali_browser.runtime import DaliRuntime, default_config
from wb.mqtt_dali.sim.scenario import build_network, serial_config
from wb.mqtt_dali.sim.control_gear import SimulatedControlDevice

from .conftest import GATEWAY_DEVICE_ID
from .test_runtime_editor_rpc import wait_for_commissioning

VENDOR_DIR = Path(__file__).parent.parent / "vendor"


def scenario_with(gear, devices):
    return {
        "gateways": [
            {
                "id": GATEWAY_DEVICE_ID,
                "slaveId": 1,
                "buses": {"1": {"gear": gear, "devices": devices}, "2": {}, "3": {}},
            }
        ]
    }


@pytest.fixture
async def runtime(tmp_path, request):
    scenario = request.param
    network = build_network(scenario)
    instance = DaliRuntime(
        transport=network,
        serial_config=serial_config(scenario),
        config=default_config([GATEWAY_DEVICE_ID]),
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await instance.start()
    instance.network = network
    try:
        yield instance
    finally:
        await instance.stop()


async def scan(runtime):
    progress = []
    runtime.subscribe(
        f"/wb-dali/{GATEWAY_DEVICE_ID}_bus_1/commissioning",
        lambda _topic, payload, _retain: progress.append(json.loads(payload)) if payload else None,
    )
    await runtime.rpc("Editor", "ScanBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})
    await wait_for_commissioning(progress)
    return progress[-1]


@pytest.mark.parametrize(
    "runtime",
    [scenario_with([], [{"shortAddress": None, "randomAddress": 0x2B3C4D}])],
    indirect=True,
)
async def test_an_unaddressed_input_device_is_found_and_addressed(runtime):
    final = await scan(runtime)

    assert final["status"] == "completed"
    assert final["device_count"] == 1
    device = runtime.network.gateways[GATEWAY_DEVICE_ID].buses[1].dali_bus.devices[0]
    assert device.short_address == 0

    gateways = await runtime.rpc("Editor", "GetList")
    assert [item["name"] for item in gateways[0]["buses"][0]["devices"]] == ["DALI-2 0"]


@pytest.mark.parametrize(
    "runtime",
    [
        scenario_with(
            [{"shortAddress": None, "randomAddress": 0x1A2B3C, "deviceTypes": [6]}],
            [{"shortAddress": None, "randomAddress": 0x2B3C4D}],
        )
    ],
    indirect=True,
)
async def test_gear_and_devices_are_addressed_independently(runtime):
    """Control gear and control devices have separate short-address spaces."""
    final = await scan(runtime)

    assert final["status"] == "completed"
    assert final["device_count"] == 2

    bus = runtime.network.gateways[GATEWAY_DEVICE_ID].buses[1].dali_bus
    assert bus.gear[0].shortaddr == 0
    assert bus.devices[0].short_address == 0

    gateways = await runtime.rpc("Editor", "GetList")
    names = sorted(item["name"] for item in gateways[0]["buses"][0]["devices"])
    assert names == ["DALI 0", "DALI-2 0"]


@pytest.mark.parametrize(
    "runtime",
    [
        scenario_with(
            [],
            [
                {"shortAddress": None, "randomAddress": 0x000100},
                {"shortAddress": None, "randomAddress": 0xF00000},
            ],
        )
    ],
    indirect=True,
)
async def test_several_input_devices_get_distinct_addresses(runtime):
    final = await scan(runtime)

    assert final["device_count"] == 2
    devices = runtime.network.gateways[GATEWAY_DEVICE_ID].buses[1].dali_bus.devices
    assert sorted(device.short_address for device in devices) == [0, 1]


@pytest.mark.parametrize(
    "runtime",
    [scenario_with([], [{"shortAddress": 0, "randomAddress": 0x2B3C4D}])],
    indirect=True,
)
async def test_an_input_device_reports_its_instances(runtime):
    """Opening a DALI-2 device reads every instance's settings in one batch.

    An unanswered query fails the batch as a whole, so this is really a check
    that none of the per-instance settings is missing.
    """
    await scan(runtime)
    gateways = await runtime.rpc("Editor", "GetList")
    device_id = gateways[0]["buses"][0]["devices"][0]["id"]

    info = await asyncio.wait_for(
        runtime.rpc("Editor", "GetDevice", {"deviceId": device_id}), 90
    )

    config = info["config"]
    assert config["short_address"] == 0
    assert config["random_address"] == "0x2b3c4d"
    # 32 device groups, none of them joined yet (IEC 62386-103 §9.7).
    assert config["device_groups"] == [False] * 32
    # Four pushbutton instances, each with the priority a user action carries
    # and the press timers of IEC 62386-301.
    assert config["instance0"]["event_priority"] == 3
    assert config["instance0"]["short_timer"] == 400
    assert config["instance0"]["stuck_timer"] == 20
    assert sorted(key for key in config if key.startswith("instance")) == [
        "instance0",
        "instance1",
        "instance2",
        "instance3",
    ]


@pytest.mark.parametrize(
    "runtime",
    [scenario_with([], [{"shortAddress": 0, "randomAddress": 0x2B3C4D}])],
    indirect=True,
)
async def test_instances_are_configured_independently(runtime):
    """`fakes.Device` keeps its instance list on the class, shared by every device."""
    device = runtime.network.gateways[GATEWAY_DEVICE_ID].buses[1].dali_bus.devices[0]
    other = SimulatedControlDevice(shortaddr=1, random_address=0x999999)

    # pylint: disable=protected-access
    device._instance_settings[0].short_timer = 99

    assert other._instance_settings[0].short_timer != 99
