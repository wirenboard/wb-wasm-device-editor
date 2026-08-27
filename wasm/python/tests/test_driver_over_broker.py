"""The unmodified `WBDALIDriver` driving the simulated gateway.

This is the load-bearing test of the whole design: if the production driver can
send a frame and get its answer back with nothing but the loopback broker, the
emulated wb-mqtt-serial and the simulated bus underneath it, then everything
above the driver — commissioning, device parameters, the Editor RPC — is
unchanged production code.
"""

import asyncio

import pytest
from dali.address import GearBroadcast, GearShort
from dali.gear.general import DAPC, Off, QueryActualLevel, QueryControlGearPresent
from dali.tests import fakes

from wb.mqtt_dali.wbdali import WBDALIConfig, WBDALIDriver
from wb.mqtt_dali.wbdali_error_response import GatewayUnavailable, NoResponseFromGateway

from .conftest import GATEWAY_DEVICE_ID, SimulatedStack


async def make_driver(stack, logger, bus: int = 1) -> WBDALIDriver:
    driver = WBDALIDriver(
        WBDALIConfig(device_name=GATEWAY_DEVICE_ID, bus=bus),
        mqtt_dispatcher=stack.dispatcher,
        logger=logger,
    )
    await driver.initialize()
    return driver


async def test_query_reaches_the_gear_and_the_answer_comes_back(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    try:
        await driver.send(DAPC(GearShort(0), 200))
        response = await driver.send(
            QueryActualLevel(GearShort(0))
        )

        assert response.value == 200
        assert stack.buses[1].gear[0].level == 200
    finally:
        await driver.deinitialize()


async def test_command_without_an_answer_completes(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    try:
        response = await driver.send(
            Off(GearBroadcast())
        )

        assert response.raw_value is None
        assert stack.buses[1].gear[0].level == 0
    finally:
        await driver.deinitialize()


async def test_batch_of_commands_maps_to_reply_slots_in_order(stack, dali_logger):
    """A batch fills consecutive queue slots; each answer must land on its own command."""
    driver = await make_driver(stack, dali_logger)
    try:
        await driver.send_commands(
            [DAPC(GearShort(0), 10), DAPC(GearShort(1), 20)]
        )
        responses = await driver.send_commands(
            [QueryActualLevel(GearShort(0)), QueryActualLevel(GearShort(1))]
        )

        assert [response.value for response in responses] == [10, 20]
    finally:
        await driver.deinitialize()


async def test_query_to_an_empty_address_reports_no_answer(stack, dali_logger):
    driver = await make_driver(stack, dali_logger)
    try:
        response = await driver.send(
            QueryControlGearPresent(GearShort(40))
        )

        assert response.raw_value is None
    finally:
        await driver.deinitialize()


async def test_an_unwired_bus_is_silent(stack, dali_logger):
    """Buses 2 and 3 of the module exist but have no gear on them."""
    driver = await make_driver(stack, dali_logger, bus=2)
    try:
        response = await driver.send(
            QueryControlGearPresent(GearShort(0))
        )

        assert response.raw_value is None
    finally:
        await driver.deinitialize()


async def test_more_commands_than_the_queue_holds_are_split_into_batches(dali_logger):
    """The gateway queue is 16 slots deep; a longer batch must still resolve fully."""
    stack = SimulatedStack(gear=[fakes.Gear(shortaddr=index) for index in range(20)])
    await stack.start()
    try:
        driver = await make_driver(stack, dali_logger)
        try:
            responses = await driver.send_commands(
                [QueryControlGearPresent(GearShort(index)) for index in range(20)]
            )

            assert len(responses) == 20
            assert all(response.value for response in responses)
        finally:
            await driver.deinitialize()
    finally:
        await stack.stop()


async def test_a_silent_gateway_times_out_instead_of_hanging(stack, dali_logger):
    """A module that stops answering Modbus must not leave the caller waiting forever."""
    driver = await make_driver(stack, dali_logger)
    driver.response_timeout = 0.2
    try:
        stack.gateway.reachable = False

        response = await asyncio.wait_for(driver.send(QueryActualLevel(GearShort(0))), timeout=2.0)

        assert isinstance(response, NoResponseFromGateway)
    finally:
        await driver.deinitialize()


async def test_meta_error_marks_the_gateway_unavailable(stack, dali_logger):
    """wb-mqtt-serial reports an unreachable device as `r`; pending traffic fails fast."""
    driver = await make_driver(stack, dali_logger)
    try:
        stack.serial.publish_availability(GATEWAY_DEVICE_ID, reachable=False)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        response = await asyncio.wait_for(driver.send(QueryActualLevel(GearShort(0))), timeout=1.0)
        assert isinstance(response, GatewayUnavailable)

        stack.serial.publish_availability(GATEWAY_DEVICE_ID, reachable=True)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        response = await asyncio.wait_for(driver.send(QueryActualLevel(GearShort(0))), timeout=1.0)
        assert response.value == 0
    finally:
        await driver.deinitialize()
