"""The real-hardware transport, driven against the virtual gateway.

There was no WB-DALI module to test against, so `port/Load` is stubbed with one
that reads and writes the simulated gateway's registers. That leaves exactly the
part this class adds under test: deciding which reply slots a write covered, and
polling them back out of the gateway's input registers instead of waiting for
the sporadic-event stream a browser cannot subscribe to.
"""

import asyncio

import pytest

from wbdali_browser.hardware import (
    ModbusError,
    WasmSerialTransport,
    hex_to_registers,
    queue_slots_written,
)
from wbdali_browser.serial_service import registers_to_hex
from wbdali_browser.sim.control_gear import SimulatedControlGear
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.gateway import VirtualWbDaliGateway

from .conftest import GATEWAY_DEVICE_ID

SLAVE_ID = 1


def make_gateway():
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x1A2B3C))
    return VirtualWbDaliGateway(buses)


def make_port_load(gateway, calls=None):
    """Stand in for `Module.request('portLoad', ...)` over WebSerial."""

    async def port_load(request):
        if calls is not None:
            calls.append(request)
        assert request["protocol"] == "modbus"
        assert request["slave_id"] == SLAVE_ID
        assert request["format"] == "HEX"
        function = request["function"]
        if function == 16:
            gateway.write_holding(request["address"], hex_to_registers(request["msg"]))
            return {"response": ""}
        if function == 4:
            return {"response": registers_to_hex(gateway.read_input(request["address"], request["count"]))}
        if function == 3:
            return {"response": registers_to_hex(gateway.read_holding(request["address"], request["count"]))}
        raise AssertionError(f"unexpected Modbus function {function}")

    return port_load


@pytest.mark.parametrize(
    "address, registers, expected",
    [
        (1400, 2, (1, 0, 1)),
        (1402, 2, (1, 1, 1)),
        (1400, 6, (1, 0, 3)),
        (1430, 2, (1, 15, 1)),
        (2400, 2, (2, 0, 1)),
        (3406, 4, (3, 3, 2)),
        (1432, 1, None),  # the bulk-send pointer, not a queue slot
        (1500, 1, None),  # a reply register
    ],
)
def test_queue_slot_arithmetic(address, registers, expected):
    assert queue_slots_written(address, registers) == expected


async def test_a_written_slot_is_polled_back_and_published():
    gateway = make_gateway()
    published = []
    transport = WasmSerialTransport(make_port_load(gateway), {GATEWAY_DEVICE_ID: SLAVE_ID})
    transport.bind(lambda device, control, value: published.append((device, control, value)))

    # QueryActualLevel to short address 0, encoded the way the driver would.
    await transport.write_holding(GATEWAY_DEVICE_ID, 1400, [0x01A0, 0x8000])

    assert published == [(GATEWAY_DEVICE_ID, "bus_1_bulk_send_reply_0", 0x0100)]


async def test_only_the_slots_of_this_batch_are_published():
    """A reply register keeps its value until the slot is reused.

    Republishing one the driver has already consumed would resolve a later
    command's future with an earlier command's answer.
    """
    gateway = make_gateway()
    published = []
    transport = WasmSerialTransport(make_port_load(gateway), {GATEWAY_DEVICE_ID: SLAVE_ID})
    transport.bind(lambda device, control, value: published.append((device, control, value)))

    await transport.write_holding(GATEWAY_DEVICE_ID, 1400, [0x01A0, 0x8000])
    published.clear()
    await transport.write_holding(GATEWAY_DEVICE_ID, 1402, [0x01A0, 0x8000])

    assert [control for _device, control, _value in published] == ["bus_1_bulk_send_reply_1"]


async def test_a_write_outside_the_queue_polls_nothing():
    gateway = make_gateway()
    published = []
    transport = WasmSerialTransport(make_port_load(gateway), {GATEWAY_DEVICE_ID: SLAVE_ID})
    transport.bind(lambda device, control, value: published.append((device, control, value)))

    # The queue reset: the bulk-send pointer, which produces no reply.
    await transport.write_holding(GATEWAY_DEVICE_ID, 1432, [0])

    assert published == []


async def test_reads_go_out_as_modbus_reads():
    gateway = make_gateway()
    calls = []
    transport = WasmSerialTransport(make_port_load(gateway, calls), {GATEWAY_DEVICE_ID: SLAVE_ID})

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
        return {"error": {"code": -32000, "message": "Request timed out"}}

    transport = WasmSerialTransport(failing_port_load, {GATEWAY_DEVICE_ID: SLAVE_ID})

    with pytest.raises(ModbusError, match="timed out"):
        await transport.read_input(GATEWAY_DEVICE_ID, 1500, 1)


async def test_a_silent_slot_gives_up_instead_of_polling_forever():
    """A gateway that never transmits must not block the caller indefinitely."""
    gateway = make_gateway()

    async def port_load(request):
        if request["function"] == 16:
            return {"response": ""}  # accept the write, never transmit
        return {"response": registers_to_hex([0] * request["count"])}

    transport = WasmSerialTransport(port_load, {GATEWAY_DEVICE_ID: SLAVE_ID})
    transport.bind(lambda *_: None)

    await asyncio.wait_for(
        transport.write_holding(GATEWAY_DEVICE_ID, 1400, [0x01A0, 0x8000]), timeout=5.0
    )


async def test_a_module_that_stops_answering_is_reported_unreachable():
    """`/meta/error` is how the driver learns to fail fast.

    Without it every command waits out its own 1.5 s timeout, and the daemon's
    retries keep new ones coming — so a gateway that is simply not connected
    turns into an unbounded stream of doomed requests.
    """
    availability = []

    async def failing_port_load(_request):
        return {"error": "Request timed out"}

    transport = WasmSerialTransport(failing_port_load, {GATEWAY_DEVICE_ID: SLAVE_ID})
    transport.bind(
        lambda *_: None,
        lambda device, reachable: availability.append((device, reachable)),
    )

    for _ in range(3):
        with pytest.raises(ModbusError):
            await transport.read_input(GATEWAY_DEVICE_ID, 1500, 1)

    assert availability == [(GATEWAY_DEVICE_ID, False)]


async def test_a_module_that_answers_again_is_reported_reachable():
    replies = [{"error": "timeout"}] * 3 + [{"response": "0000"}]

    async def flaky_port_load(_request):
        return replies.pop(0)

    availability = []
    transport = WasmSerialTransport(flaky_port_load, {GATEWAY_DEVICE_ID: SLAVE_ID})
    transport.bind(
        lambda *_: None,
        lambda device, reachable: availability.append((device, reachable)),
    )

    for _ in range(3):
        with pytest.raises(ModbusError):
            await transport.read_input(GATEWAY_DEVICE_ID, 1500, 1)
    await transport.read_input(GATEWAY_DEVICE_ID, 1500, 1)

    assert availability == [(GATEWAY_DEVICE_ID, False), (GATEWAY_DEVICE_ID, True)]
