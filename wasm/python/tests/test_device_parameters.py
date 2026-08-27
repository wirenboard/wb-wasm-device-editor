"""Reading a device's parameters, which is what opening one in the editor does.

`Editor/GetDevice` initialises the unit on the bus and then reads every
parameter its device types imply, in batches. A batch fails as a whole if any
one query goes unanswered, so a gap in the simulated gear does not degrade the
form — it empties it. These tests pin the two device types the editor is most
likely to meet.
"""

from pathlib import Path

import pytest

from wbdali_browser.runtime import DaliRuntime
from wbdali_browser.sim.control_gear import SimulatedControlGear
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.network import SimulatedModbusNetwork

from .conftest import GATEWAY_DEVICE_ID, serial_config_with

VENDOR_DIR = Path(__file__).parent.parent / "vendor"

LED_DRIVER = {"short": 0, "random": 0x1A2B3C}
COLOUR_DRIVER = {"short": 2, "random": 0x7A8B9C}


@pytest.fixture
async def runtime(tmp_path):
    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(
        SimulatedControlGear(shortaddr=0, random_address=LED_DRIVER["random"], devicetypes=[6])
    )
    buses[1].add_gear(
        SimulatedControlGear(shortaddr=2, random_address=COLOUR_DRIVER["random"], devicetypes=[8])
    )
    network.add_module(GATEWAY_DEVICE_ID, buses)

    instance = DaliRuntime(
        transport=network,
        serial_config=serial_config_with(GATEWAY_DEVICE_ID),
        config={
            "debug": False,
            "gateways": [
                {
                    "device_id": GATEWAY_DEVICE_ID,
                    "buses": [{"devices": [LED_DRIVER, COLOUR_DRIVER]}, {"devices": []}, {"devices": []}],
                }
            ],
        },
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await instance.start()
    instance.buses = buses
    try:
        yield instance
    finally:
        await instance.stop()


async def device_ids(runtime):
    gateways = await runtime.rpc("Editor", "GetList")
    return [device["id"] for device in gateways[0]["buses"][0]["devices"]]


async def test_led_driver_parameters_are_all_readable(runtime):
    led, _colour = await device_ids(runtime)

    info = await runtime.rpc("Editor", "GetDevice", {"deviceId": led})

    config = info["config"]
    assert config["short_address"] == 0
    assert config["random_address"] == "0x1a2b3c"
    # Identity out of the simulated memory bank 0, and the gear variables of
    # IEC 62386-102 that the fake control gear does not implement on its own.
    assert config["gtin"] == 1234567654321
    assert config["firmware_version"] == "1.0"
    assert config["power_on_level"] == 254
    assert config["system_failure_level"] == 254
    assert config["fade_rate"] == 7
    assert config["fade_time"] == 0
    assert info["schema"]["properties"]["power_on_level"]


async def test_colour_driver_reports_its_colour_parameters(runtime):
    _led, colour = await device_ids(runtime)

    info = await runtime.rpc("Editor", "GetDevice", {"deviceId": colour})

    config = info["config"]
    assert config["short_address"] == 2
    # A DT8 unit that reports colour temperature gets the Tc controls, and the
    # limits the simulated gear declares.
    assert config["current_colour_32"] == {"tc": 0, "level": 0}
    assert config["tc_limits"] == {
        "tc_coolest": 153,
        "tc_warmest": 370,
        "tc_physical_coolest": 153,
        "tc_physical_warmest": 370,
    }


async def test_an_unknown_device_id_is_an_error_not_a_hang(runtime):
    with pytest.raises(Exception) as error:
        await runtime.rpc("Editor", "GetDevice", {"deviceId": "no-such-device"}, timeout=15)

    assert "not found" in str(error.value)
