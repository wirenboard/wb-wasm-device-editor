"""Answers the one wb-mqtt-serial RPC the daemon's boot depends on.

`Gateway.start()` refuses to proceed until `/rpc/v1/wb-mqtt-serial/config/Load`
exists, and then calls it to learn which devices are WB-DALI gateways —
anything not listed there it deletes from its own config. That is the entire
dependency: the DALI traffic itself does not go through MQTT at all, it goes
straight to Modbus registers through the driver.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from .broker import Broker, Client, Message, get_payload_str

logger = logging.getLogger("wbdali_browser.serial")

CONFIG_LOAD_TOPIC = "/rpc/v1/wb-mqtt-serial/config/Load"
REQUEST_FILTER = CONFIG_LOAD_TOPIC + "/+"


class WbMqttSerialConfigService:
    """Publishes wb-mqtt-serial's device list, and nothing else."""

    def __init__(
        self,
        broker: Broker,
        serial_config: Dict[str, Any],
        client_id: str = "wb-mqtt-serial-config",
    ) -> None:
        self.broker = broker
        self.serial_config = serial_config
        self.client = Client(broker, client_id)
        self._task: Optional[asyncio.Task] = None

    @property
    def device_ids(self) -> List[str]:
        return [
            device["id"]
            for port in self.serial_config.get("ports", [])
            for device in port.get("devices", [])
            if "id" in device
        ]

    async def start(self) -> None:
        await self.client.__aenter__()
        await self.client.subscribe(REQUEST_FILTER)
        # The retained marker is what `wait_for_rpc_endpoint` blocks on; publish
        # it before the daemon starts.
        self.broker.publish(CONFIG_LOAD_TOPIC, "1", qos=1, retain=True)
        self._task = asyncio.create_task(self._serve(), name="wb-mqtt-serial-config")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self.client.__aexit__(None, None, None)

    async def _serve(self) -> None:
        async for message in self.client.messages:
            self._reply(message)

    def _reply(self, message: Message) -> None:
        try:
            request = json.loads(get_payload_str(message))
        except ValueError:
            logger.error("Malformed config/Load request: %r", message.payload)
            return
        self.broker.publish(
            message.topic.value + "/reply",
            json.dumps({"id": request.get("id"), "result": {"config": self.serial_config}}),
            qos=2,
        )
