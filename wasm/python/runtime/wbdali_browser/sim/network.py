"""Wires simulated WB-DALI modules to the emulated wb-mqtt-serial.

This is the bottom of the stack in simulation mode. It implements
:class:`~wbdali_browser.serial_service.ModbusTransport`, and it turns the
gateway's reply and bus-monitor register updates into the MQTT controls that
wb-mqtt-serial would publish — which is how `WBDALIDriver` learns what happened
on the bus.

The real-hardware transport is the sibling of this class: same interface, but
`read_*`/`write_holding` go out to the C++ WASM module's `portLoad` over
WebSerial, and the reply controls come from polling the same registers.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Dict, List, Optional

from .dali_bus import SimulatedDaliBus
from .gateway import VirtualWbDaliGateway

logger = logging.getLogger("wbdali_browser.sim.network")

ControlPublisher = Callable[[str, str, object], None]


class SimulatedModbusNetwork:
    """A Modbus network populated with simulated WB-DALI modules.

    :param frame_delay_s: wall-clock cost charged per DALI frame. Zero keeps the
        UI instant; a realistic value (~0.014 s for a 16-bit frame at 1200 baud)
        makes the driver's batching and timeout logic behave as it does on real
        hardware, at the price of a slow commissioning scan.
    """

    def __init__(self, frame_delay_s: float = 0.0) -> None:
        self.gateways: Dict[str, VirtualWbDaliGateway] = {}
        self.frame_delay_s = frame_delay_s
        self._publish_control: Optional[ControlPublisher] = None

    # -- construction -----------------------------------------------------

    def add_module(self, device_id: str, buses: Dict[int, SimulatedDaliBus]) -> VirtualWbDaliGateway:
        gateway = VirtualWbDaliGateway(
            buses,
            on_reply=lambda bus, slot, value: self._publish(
                device_id, f"bus_{bus}_bulk_send_reply_{slot}", value
            ),
            on_monitor=lambda bus, slot, value: self._publish(
                device_id, f"bus_{bus}_monitor_sporadic_frame_{slot + 1}", value
            ),
        )
        self.gateways[device_id] = gateway
        return gateway

    def bind(self, publish_control: ControlPublisher) -> None:
        """Attach the emulated wb-mqtt-serial that publishes this network's controls."""
        self._publish_control = publish_control

    def _publish(self, device_id: str, control: str, value: object) -> None:
        if self._publish_control is None:
            logger.debug("Dropping %s/%s=%s: no publisher bound", device_id, control, value)
            return
        self._publish_control(device_id, control, value)

    # -- ModbusTransport --------------------------------------------------

    async def read_holding(self, device_id: str, address: int, count: int) -> List[int]:
        gateway = self._require(device_id)
        await self._charge_bus_time(1)
        return gateway.read_holding(address, count)

    async def read_input(self, device_id: str, address: int, count: int) -> List[int]:
        gateway = self._require(device_id)
        await self._charge_bus_time(1)
        return gateway.read_input(address, count)

    async def write_holding(self, device_id: str, address: int, values: List[int]) -> None:
        gateway = self._require(device_id)
        # A queue slot is two registers, so the register count is the frame
        # count. Charge the bus time before transmitting, so replies never
        # appear earlier than the frames that produced them could have.
        await self._charge_bus_time(max(1, len(values) // 2))
        gateway.write_holding(address, values)

    def _require(self, device_id: str) -> VirtualWbDaliGateway:
        gateway = self.gateways.get(device_id)
        if gateway is None:
            raise ValueError(f"No device {device_id!r} on the bus")
        if not gateway.reachable:
            raise TimeoutError(f"Device {device_id!r} did not answer")
        return gateway

    async def _charge_bus_time(self, frames: int) -> None:
        if self.frame_delay_s and frames > 0:
            await asyncio.sleep(self.frame_delay_s * frames)
        else:
            # Always yield, so a caller looping over transactions cannot starve
            # the event loop the way a purely synchronous transport would.
            await asyncio.sleep(0)
