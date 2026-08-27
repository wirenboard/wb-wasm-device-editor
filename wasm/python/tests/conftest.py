import asyncio
import logging

import pytest

from wbdali_browser.broker import Broker, Client
from wbdali_browser.serial_service import WbMqttSerialEmulator
from wbdali_browser.sim.control_gear import SimulatedControlGear
from wbdali_browser.sim.dali_bus import SimulatedDaliBus
from wbdali_browser.sim.network import SimulatedModbusNetwork

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
    """Broker + emulated wb-mqtt-serial + simulated WB-DALI module, wired together."""

    def __init__(self, gear=(), devices=(), frame_delay_s: float = 0.0) -> None:
        self.broker = Broker()
        self.network = SimulatedModbusNetwork(frame_delay_s=frame_delay_s)
        self.buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
        for unit in gear:
            self.buses[1].add_gear(unit)
        for unit in devices:
            self.buses[1].add_device(unit)
        self.gateway = self.network.add_module(GATEWAY_DEVICE_ID, self.buses)
        self.serial = WbMqttSerialEmulator(
            self.broker, self.network, serial_config_with(GATEWAY_DEVICE_ID)
        )
        self.network.bind(self.serial.publish_control)
        self._dispatcher_task = None
        self.dispatcher = None

    async def start(self):
        from wb.mqtt_dali.mqtt_dispatcher import MQTTDispatcher

        await self.serial.start()
        self.client = Client(self.broker, "wb-mqtt-dali-test")
        await self.client.__aenter__()
        self.dispatcher = MQTTDispatcher(self.client)
        self._dispatcher_task = asyncio.create_task(self.dispatcher.run(), name="dispatcher")
        return self

    async def stop(self):
        if self._dispatcher_task is not None:
            self._dispatcher_task.cancel()
            try:
                await self._dispatcher_task
            except asyncio.CancelledError:
                pass
        await self.client.__aexit__(None, None, None)
        await self.serial.stop()


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
