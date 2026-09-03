import logging

import pytest

from wb.mqtt_dali.gateway_link import RegisterLink
from wb.mqtt_dali.wbdali import WBDALIConfig, WBDALIDriver
from wb.mqtt_dali.sim.control_gear import SimulatedControlGear
from wb.mqtt_dali.sim.dali_bus import SimulatedDaliBus
from wb.mqtt_dali.sim.network import SimulatedModbusNetwork

GATEWAY_DEVICE_ID = "wb-mdali_1"


def serial_config_with(*device_ids: str) -> dict:
    """The subset of wb-mqtt-serial's config that `Gateway._update_gateways` reads."""
    return {
        "ports": [
            {
                "path": "/dev/ttyWBSIM",
                "enabled": True,
                "devices": [
                    {
                        "id": device_id,
                        "slave_id": index + 1,
                        "device_type": "WB-DALI",
                        "enabled": True,
                    }
                    for index, device_id in enumerate(device_ids)
                ],
            }
        ]
    }


class SimulatedStack:
    """A simulated WB-DALI module and a driver talking to it over registers."""

    def __init__(self, gear=(), devices=(), frame_delay_s: float = 0.0) -> None:
        self.network = SimulatedModbusNetwork(frame_delay_s=frame_delay_s)
        self.buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
        for unit in gear:
            self.buses[1].add_gear(unit)
        for unit in devices:
            self.buses[1].add_device(unit)
        self.gateway = self.network.add_module(GATEWAY_DEVICE_ID, self.buses)

    async def start(self):
        return self

    async def stop(self):
        return None

    def driver(self, bus: int = 1, logger=None, transport=None) -> WBDALIDriver:
        config = WBDALIConfig(device_name=GATEWAY_DEVICE_ID, bus=bus)
        logger = logger or logging.getLogger("test")
        link = RegisterLink(config, transport if transport is not None else self.network, logger)
        return WBDALIDriver(config, None, logger, link=link)


@pytest.fixture
def dali_logger():
    return logging.getLogger("test")


@pytest.fixture
async def stack():
    instance = SimulatedStack(
        gear=[
            SimulatedControlGear(shortaddr=0, random_address=0x000010),
            SimulatedControlGear(shortaddr=1, random_address=0x400000),
        ]
    )
    await instance.start()
    try:
        yield instance
    finally:
        await instance.stop()
