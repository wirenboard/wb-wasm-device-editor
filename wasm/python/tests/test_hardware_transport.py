"""The register transport that reaches a real WB-DALI module over WebSerial.

There was no module to test against, so `port/Load` is stubbed with one that
reads and writes the simulated gateway's registers. What that leaves under test
is the Modbus request this builds and the hex encoding either way; the framing
below it is the same C++ code the Modbus editor already uses, and the DALI
protocol above it belongs to the driver.
"""

import pytest

from wb.mqtt_dali.gateway_link import RegisterLink
from wb.mqtt_dali.wbdali import WBDALIDriver
from wbdali_browser.hardware import (
    ModbusError,
    WasmSerialTransport,
    hex_to_registers,
    registers_to_hex,
)
from wb.mqtt_dali.sim.control_gear import SimulatedControlGear
from wb.mqtt_dali.sim.dali_bus import SimulatedDaliBus
from wb.mqtt_dali.sim.gateway import VirtualWbDaliGateway

from .conftest import GATEWAY_DEVICE_ID

SLAVE_ID = 1


def make_gateway():
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x1A2B3C))
    return VirtualWbDaliGateway(buses)


def make_port_load(gateway, calls=None):
    """Stand in for `Module.request('portLoad', ...)` over WebSerial.

    Answers in the same JSON-RPC envelope the real one does — `{error, result}`
    with the payload one level down. An earlier version of this double returned
    the inner object directly, so the transport read the wrong field and every
    register read came back empty. Against the simulator that is invisible;
    against a real gateway it is every command timing out.
    """

    async def port_load(request):
        if calls is not None:
            calls.append(request)
        assert request["protocol"] == "modbus"
        assert request["slave_id"] == SLAVE_ID
        assert request["format"] == "HEX"
        function = request["function"]
        if function in (6, 16):
            gateway.write_holding(request["address"], hex_to_registers(request["msg"]))
            return {"error": None, "result": {"response": ""}}
        if function == 4:
            registers = gateway.read_input(request["address"], request["count"])
            return {"error": None, "result": {"response": registers_to_hex(registers)}}
        raise AssertionError(f"unexpected Modbus function {function}")

    return port_load


@pytest.mark.parametrize(
    "registers, hexed",
    [([0x1234], "1234"), ([0x01A0, 0x8000], "01a08000"), ([], "")],
)
def test_register_hex_round_trip(registers, hexed):
    assert registers_to_hex(registers) == hexed
    assert hex_to_registers(hexed) == registers


def test_a_truncated_reply_is_an_error_not_a_silent_short_read():
    with pytest.raises(ModbusError):
        hex_to_registers("12")


async def test_a_write_goes_out_as_a_multiple_register_write():
    calls = []
    transport = WasmSerialTransport(make_port_load(make_gateway(), calls), {GATEWAY_DEVICE_ID: SLAVE_ID})

    await transport.write_holding(GATEWAY_DEVICE_ID, 1400, [0x01A0, 0x8000])

    assert calls[-1]["function"] == 16
    assert calls[-1]["address"] == 1400
    assert calls[-1]["count"] == 2
    assert calls[-1]["msg"] == "01a08000"


async def test_reads_go_out_as_input_register_reads():
    calls = []
    transport = WasmSerialTransport(make_port_load(make_gateway(), calls), {GATEWAY_DEVICE_ID: SLAVE_ID})

    await transport.read_input(GATEWAY_DEVICE_ID, 1500, 4)

    assert calls[-1]["function"] == 4
    assert calls[-1]["address"] == 1500
    assert calls[-1]["count"] == 4


async def test_an_unknown_module_is_an_error():
    transport = WasmSerialTransport(make_port_load(make_gateway()), {})

    with pytest.raises(ModbusError):
        await transport.read_input("wb-mdali_9", 1500, 1)


async def test_a_modbus_error_reply_is_raised():
    async def failing_port_load(_request):
        return {"error": {"code": -32000, "message": "Request timed out"}, "result": None}

    transport = WasmSerialTransport(failing_port_load, {GATEWAY_DEVICE_ID: SLAVE_ID})

    with pytest.raises(ModbusError, match="timed out"):
        await transport.read_input(GATEWAY_DEVICE_ID, 1500, 1)


async def test_the_driver_runs_over_this_transport_unchanged(dali_logger):
    """The whole point of the transport seam: swap it and nothing else changes."""
    from dali.address import GearShort
    from dali.gear.general import DAPC, QueryActualLevel
    from wb.mqtt_dali.wbdali import WBDALIConfig

    gateway = make_gateway()
    transport = WasmSerialTransport(make_port_load(gateway), {GATEWAY_DEVICE_ID: SLAVE_ID})
    config = WBDALIConfig(device_name=GATEWAY_DEVICE_ID, bus=1)
    driver = WBDALIDriver(config, None, dali_logger, link=RegisterLink(config, transport, dali_logger))
    await driver.initialize()
    try:
        await driver.send(DAPC(GearShort(0), 128))
        response = await driver.send(QueryActualLevel(GearShort(0)))
        assert response.value == 128
    finally:
        await driver.deinitialize()


async def test_a_single_register_write_uses_function_6():
    """The queue-pointer reset is one register, and that is what fc 6 is for."""
    calls = []
    transport = WasmSerialTransport(make_port_load(make_gateway(), calls), {GATEWAY_DEVICE_ID: SLAVE_ID})

    await transport.write_holding(GATEWAY_DEVICE_ID, 1432, [0])

    assert calls[-1]["function"] == 6
    assert calls[-1]["address"] == 1432


async def test_line_settings_come_from_the_scenario():
    calls = []
    transport = WasmSerialTransport(
        make_port_load(make_gateway(), calls),
        {GATEWAY_DEVICE_ID: SLAVE_ID},
        {"baud_rate": 115200, "data_bits": 8, "parity": "E", "stop_bits": 1},
    )

    await transport.read_input(GATEWAY_DEVICE_ID, 1500, 1)

    assert calls[-1]["baud_rate"] == 115200
    assert calls[-1]["parity"] == "E"


async def test_a_short_read_is_an_error_not_an_empty_list():
    """An envelope read at the wrong depth yields no registers, not a failure.

    That is how a wrong field goes unnoticed: the driver sees an empty list,
    indexes it, and reports "no response from gateway" — nowhere near the cause.
    """
    async def truncating_port_load(_request):
        return {"error": None, "result": {"response": ""}}

    transport = WasmSerialTransport(truncating_port_load, {GATEWAY_DEVICE_ID: SLAVE_ID})

    with pytest.raises(ModbusError, match="got 0"):
        await transport.read_input(GATEWAY_DEVICE_ID, 1500, 2)
