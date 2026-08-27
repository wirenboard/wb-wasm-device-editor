"""Boots wb-mqtt-dali in a browser and exposes it to JavaScript.

The daemon is started the way `main.py::default_service` starts it, minus the
parts a browser cannot provide: no broker connection, no signal handlers, no
journal. What replaces them is a loopback broker for the daemon's own
publishing, a stub for the one wb-mqtt-serial RPC its boot depends on, a
pre-seeded virtual filesystem, and a DALI driver that reaches the gateway over
Modbus registers instead of MQTT.

Boot order is not negotiable (see `Gateway.start()`):

1. `MQTTDispatcher.run()` must already be dispatching, or every subscribe below
   it silently never delivers;
2. the emulated wb-mqtt-serial must already have published its retained endpoint
   marker, because `Gateway.start()` waits up to five seconds for
   `/rpc/v1/wb-mqtt-serial/config/Load` to exist and gives up otherwise;
3. only then `Gateway.start()`.

The web UI attaches to the same broker as an ordinary MQTT client and speaks
MQTT-RPC, exactly as homeui does against a real controller — so the DALI page
runs unmodified too.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .broker import Broker, Client, Message, get_payload_str
from .dali_driver import RegisterTransport, make_driver_class
from .serial_service import WbMqttSerialConfigService

logger = logging.getLogger("wbdali_browser.runtime")

# Paths the daemon installs to on a controller. `root` shifts all of them, which
# is what keeps the test suite out of the developer's real /etc and /usr.
CONFIG_PATH = "etc/wb-mqtt-dali.conf"
DATA_DIR = "usr/share/wb-mqtt-dali"
CONFED_SCHEMA_PATH = "usr/share/wb-mqtt-confed/schemas/wb-mqtt-dali.schema.json"

# `products.csv` is a 760 KB GTIN lookup table parsed eagerly at construction.
# Shipping it is optional: without it the daemon cannot name a manufacturer and
# the editor shows the raw GTIN.
GTIN_DB_PATH = DATA_DIR + "/products.csv"

# The one path the daemon hardcodes and does not take as an argument
# (`common_dali_device.py:697`). Loading it ourselves onto the class attribute it
# caches in means that `open()` never runs.
COMMON_DEVICE_SCHEMA = "schemas/common_device.schema.json"


def default_config(gateway_ids: List[str]) -> dict:
    """A config with one three-bus gateway per WB-DALI module, and no known devices.

    Devices appear here after the first successful bus scan; the daemon rewrites
    the file itself.
    """
    return {
        "debug": False,
        "gateways": [
            {"device_id": device_id, "buses": [{"devices": []} for _ in range(3)]}
            for device_id in gateway_ids
        ],
    }


def write_config(root: Path, config: dict) -> None:
    """Put the config where the daemon expects it, in a writable directory.

    The daemon rewrites this file after every bus scan and on every
    `Editor/GetList`, so the directory has to exist and be writable — in the
    browser that means it must be a real MEMFS directory, not part of the
    read-only bundle.
    """
    config_path = root / CONFIG_PATH
    os.makedirs(config_path.parent, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as config_file:
        json.dump(config, config_file, indent=4)


def install_data_files(vendor_dir: Path, root: Path) -> None:
    """Lay out the package data the daemon reads from absolute paths.

    In the browser these arrive as a tarball unpacked straight into `/usr/share`,
    so this is only used by the tests, which install under a temporary root
    rather than the developer's real filesystem.
    """
    os.makedirs(root / DATA_DIR, exist_ok=True)
    os.makedirs((root / CONFED_SCHEMA_PATH).parent, exist_ok=True)

    _copy_if_present(vendor_dir / "schemas", root / DATA_DIR / "schemas")
    _copy_if_present(vendor_dir / "products.csv", root / GTIN_DB_PATH)
    _copy_if_present(vendor_dir / "wb-mqtt-dali.schema.json", root / CONFED_SCHEMA_PATH)

    # `common_dali_device.py` opens this one from a hardcoded absolute path
    # rather than taking it as an argument, so under a shifted root it has to be
    # placed on the class attribute the daemon caches it in.
    if root != Path("/"):
        preload_common_device_schema(vendor_dir / COMMON_DEVICE_SCHEMA)


def preload_common_device_schema(schema_path: Path) -> None:
    from wb.mqtt_dali.common_dali_device import DaliDeviceBase

    if not DaliDeviceBase._common_schema:  # pylint: disable=protected-access
        DaliDeviceBase._common_schema = json.loads(  # pylint: disable=protected-access
            schema_path.read_text(encoding="utf-8")
        )


def _copy_if_present(source: Path, target: Path) -> None:
    if not source.exists():
        logger.warning("Vendored data file %s is missing", source)
        return
    if source.is_dir():
        os.makedirs(target, exist_ok=True)
        for child in source.iterdir():
            _copy_if_present(child, target / child.name)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source.read_bytes())


class DaliRuntime:
    """One running wb-mqtt-dali, its broker, and the emulated wb-mqtt-serial."""

    def __init__(
        self,
        transport: RegisterTransport,
        serial_config: dict,
        config: Optional[dict] = None,
        vendor_dir: Optional[Path] = None,
        root: Path = Path("/"),
    ) -> None:
        self.broker = Broker()
        self.transport = transport
        self.serial = WbMqttSerialConfigService(self.broker, serial_config)
        self.config = config if config is not None else default_config(self.serial.device_ids)
        self.vendor_dir = vendor_dir
        self.root = Path(root)
        self.gateway = None
        self.dispatcher = None
        self._client: Optional[Client] = None
        self._dispatcher_task: Optional[asyncio.Task] = None
        self._ui_client: Optional[Client] = None
        self._ui_task: Optional[asyncio.Task] = None
        self._subscriptions: Dict[str, List[Callable[[str, str, bool], None]]] = {}
        self._rpc_calls = 0

    # -- lifecycle --------------------------------------------------------

    async def start(self) -> "DaliRuntime":
        from wb.mqtt_dali import application_controller
        from wb.mqtt_dali.gateway import Gateway
        from wb.mqtt_dali.gtin_db import DaliDatabase
        from wb.mqtt_dali.mqtt_dispatcher import MQTTDispatcher

        # `ApplicationController` builds its own DALI driver, handing it the MQTT
        # dispatcher it would use to reach wb-mqtt-serial. Substituting the name
        # it constructs is the whole adaptation: the browser talks to the gateway
        # over Modbus registers instead, one blocking request at a time.
        application_controller.WBDALIDriver = make_driver_class(self.transport)

        if self.vendor_dir is not None:
            install_data_files(self.vendor_dir, self.root)
        write_config(self.root, self.config)

        self._client = Client(self.broker, "wb-mqtt-dali")
        await self._client.__aenter__()
        self.dispatcher = MQTTDispatcher(self._client)
        self._dispatcher_task = asyncio.create_task(self.dispatcher.run(), name="mqtt-dispatcher")

        await self.serial.start()
        await self._start_ui_client()

        self.gateway = Gateway(
            self.config,
            self.dispatcher,
            str(self.root / CONFIG_PATH),
            DaliDatabase(str(self.root / GTIN_DB_PATH)),
        )
        await self.gateway.start()
        logger.info("wb-mqtt-dali is running")
        return self

    async def stop(self) -> None:
        if self.gateway is not None:
            await self.gateway.stop()
            self.gateway = None
        for task in (self._ui_task, self._dispatcher_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._ui_task = self._dispatcher_task = None
        for client in (self._ui_client, self._client):
            if client is not None:
                await client.__aexit__(None, None, None)
        self._ui_client = self._client = None
        await self.serial.stop()

    # -- the client the web UI talks through ------------------------------

    async def _start_ui_client(self) -> None:
        self._ui_client = Client(self.broker, "wb-dali-web-ui")
        await self._ui_client.__aenter__()
        self._ui_task = asyncio.create_task(self._deliver_to_ui(), name="ui-client")

    async def _deliver_to_ui(self) -> None:
        async for message in self._ui_client.messages:
            self._dispatch_to_ui(message)

    def _dispatch_to_ui(self, message: Message) -> None:
        from .broker import topic_matches

        payload = get_payload_str(message)
        for pattern, callbacks in list(self._subscriptions.items()):
            if not topic_matches(pattern, message.topic.value):
                continue
            for callback in list(callbacks):
                try:
                    callback(message.topic.value, payload, message.retain)
                except Exception:  # pylint: disable=broad-exception-caught
                    logger.exception("UI callback for %s failed", pattern)

    def subscribe(self, pattern: str, callback: Callable[[str, str, bool], None]) -> None:
        """Subscribe the UI to a topic filter. Retained messages are replayed.

        The filter reaches the broker synchronously: `Broker.publish` checks
        subscriptions as it delivers, so deferring this would silently drop
        anything published in the same tick as the subscribe.
        """
        callbacks = self._subscriptions.setdefault(pattern, [])
        callbacks.append(callback)
        if len(callbacks) == 1:
            # `add_filter` replays retained messages into the client's inbox,
            # from where `_dispatch_to_ui` fans them out to every matching
            # pattern — so this new subscriber gets them, and only once.
            self._ui_client.add_filter(pattern)
            return
        # A later subscriber to a filter already in place gets its own replay,
        # because the broker only replays on the first SUBSCRIBE.
        for message in self.broker.retained_matching(pattern):
            callback(message.topic.value, get_payload_str(message), True)

    def unsubscribe(self, pattern: str) -> None:
        """Drop every UI callback for a filter, matching homeui's mqttClient."""
        if self._subscriptions.pop(pattern, None) is not None and self._ui_client is not None:
            self._ui_client.remove_filter(pattern)

    def publish(self, topic: str, payload: Any = None, retain: bool = False, qos: int = 1) -> None:
        self.broker.publish(topic, payload, qos=qos, retain=retain)

    # -- persistence ------------------------------------------------------

    def watch_config(self, callback: Callable[[str], None]) -> None:
        """Report the daemon's config file whenever it changes.

        The browser's filesystem does not survive a reload, so the page has to
        keep the config itself. Rather than polling, this watches the two events
        that can follow a config write — an `Editor/*` reply and a commissioning
        state change — and reports the file when its contents actually differ.
        The daemon rewrites the file on boot, on every GetList, on SetBus,
        SetGateway and ResetDevice, and when a scan completes.
        """
        last: List[str] = [self.read_config()]

        def check(_topic: str, _payload: str, _retained: bool) -> None:
            current = self.read_config()
            if current and current != last[0]:
                last[0] = current
                callback(current)

        self.subscribe("/rpc/v1/wb-mqtt-dali/+/+/+/reply", check)
        self.subscribe("/wb-dali/+/commissioning", check)

    def read_config(self) -> str:
        try:
            return (self.root / CONFIG_PATH).read_text(encoding="utf-8")
        except OSError:
            return ""

    # -- convenience for callers that do not want to speak MQTT-RPC -------

    async def rpc(self, service: str, method: str, params: Optional[dict] = None, timeout: float = 60.0):
        """Call one wb-mqtt-dali RPC method and return its result.

        The web UI does not use this — it publishes MQTT-RPC itself, the same way
        homeui does — but tests and the console do.
        """
        self._rpc_calls += 1
        call_id = self._rpc_calls
        # One client id per call: correlation is by reply topic, and
        # `unsubscribe` drops every callback for a topic, so two concurrent
        # calls sharing one would tear down each other's subscription.
        topic = f"/rpc/v1/wb-mqtt-dali/{service}/{method}/runtime-{call_id}"
        reply_topic = topic + "/reply"
        future: asyncio.Future = asyncio.get_running_loop().create_future()

        def on_reply(_topic: str, payload: str, _retain: bool) -> None:
            if future.done():
                return
            try:
                reply = json.loads(payload)
            except ValueError as error:
                future.set_exception(error)
                return
            if reply.get("error"):
                future.set_exception(RpcError(reply["error"]))
            else:
                future.set_result(reply.get("result"))

        self.subscribe(reply_topic, on_reply)
        try:
            await asyncio.sleep(0)  # let the subscribe reach the broker
            self.publish(topic, json.dumps({"id": call_id, "params": params or {}}))
            return await asyncio.wait_for(future, timeout)
        finally:
            self.unsubscribe(reply_topic)


class RpcError(Exception):
    """An `error` object returned by a wb-mqtt-dali RPC method."""

    def __init__(self, error: dict) -> None:
        self.error = error
        super().__init__(error.get("data") or error.get("message") or "RPC error")
