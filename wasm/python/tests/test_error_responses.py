"""A gateway fault must degrade a batch, never abort it.

The gateway's error responses (NoResponseFromGateway, NoPowerOnBus, Overheat)
implement `raw_value` as a property that raises — the memo must treat them as
"nothing learned", not let the exception escape the driver's send path.
"""

import pytest
from dali.address import GearShort
from dali.gear.general import DTR0, DTR1, QuerySceneLevel, ReadMemoryLocation
from wb.mqtt_dali.bus_traffic import BusTrafficSource
from wb.mqtt_dali.wbdali import WBDALIConfig
from wb.mqtt_dali.wbdali_error_response import NoPowerOnBus, NoResponseFromGateway

from wbdali_browser.dali_driver import BlockingDaliDriver
from wbdali_browser.memory_cache import MemoryCache

from .conftest import GATEWAY_DEVICE_ID


def test_observing_a_gateway_error_learns_nothing_and_does_not_raise():
    cache = MemoryCache()
    query = QuerySceneLevel(GearShort(0), 7)

    cache.observe(query, NoResponseFromGateway(), delivered=False)
    cache.observe(query, NoPowerOnBus(), delivered=True)
    assert cache.plan([query]) is None

    cache.observe(DTR1(0), None)
    cache.observe(DTR0(3), None)
    cache.observe(ReadMemoryLocation(GearShort(0)), NoResponseFromGateway(), delivered=False)
    # The undelivered frame advanced nothing; the next delivered read still
    # lands on offset 3.
    assert cache.plan([DTR1(0), DTR0(3), ReadMemoryLocation(GearShort(0))]) is None


class _DeadGateway:
    """A transport whose gateway never reports a transmission."""

    async def read_input(self, device_id, address, count):
        return [0] * count

    async def write_holding(self, device_id, address, values):
        return None


@pytest.mark.asyncio
async def test_a_batch_of_memoizable_reads_survives_a_dead_gateway(dali_logger):
    driver = BlockingDaliDriver(
        WBDALIConfig(device_name=GATEWAY_DEVICE_ID, bus=1),
        _DeadGateway(),
        dali_logger,
        memory_cache=MemoryCache(),
    )
    driver.response_timeout = 0.05
    responses = await driver.send_commands(
        [DTR0(7), QuerySceneLevel(GearShort(0), 7)], source=BusTrafficSource.WB
    )
    # Every command gets an error *response* — the batch degrades, it does
    # not raise out of send_commands.
    assert all(isinstance(r, NoResponseFromGateway) for r in responses if r is not None)
