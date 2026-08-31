"""Boots wb-mqtt-dali in a browser and exposes it to JavaScript.

The daemon is started the way `main.py::default_service` starts it, minus the
parts a browser cannot provide: no broker connection, no signal handlers, no
journal. What replaces them comes from the daemon's own package — its
in-process broker and the stand-in for wb-mqtt-serial (`wb.mqtt_dali.sim`),
its register link for a host that owns the Modbus side
(`wb.mqtt_dali.gateway_link`) — wired through the
seams `Gateway` and `ApplicationController` offer a host: a driver factory,
group seeding, a relocatable data directory, and awaitables instead of polling.

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

from wb.mqtt_dali.common_dali_device import DATA_DIR_ENV
from wb.mqtt_dali.gateway_link import RegisterLink, RegisterTransport
from wb.mqtt_dali.mqtt_dispatcher import get_str_payload
from wb.mqtt_dali.sim.broker import Broker, Client, Message, topic_matches
from wb.mqtt_dali.sim.serial_service import FakeWbMqttSerial
from wb.mqtt_dali.wbdali import WBDALIDriver

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

# How long boot waits for the configured devices' first initialization attempts
# before showing the page with whatever has come up.
FIRST_ATTEMPTS_DEADLINE_S = 30.0
# 120 s: a populated bus takes ~20 s on real hardware; the rest is headroom
# for a bus full of unaddressed gear.
COMMISSIONING_DEADLINE_S = 120.0


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
    """Lay out the package data the daemon reads from its data directory.

    In the browser these arrive as a tarball unpacked straight into `/usr/share`,
    so this is only used by the tests, which install under a temporary root
    rather than the developer's real filesystem.
    """
    os.makedirs(root / DATA_DIR, exist_ok=True)
    os.makedirs((root / CONFED_SCHEMA_PATH).parent, exist_ok=True)

    _copy_if_present(vendor_dir / "schemas", root / DATA_DIR / "schemas")
    _copy_if_present(vendor_dir / "products.csv", root / GTIN_DB_PATH)
    _copy_if_present(vendor_dir / "wb-mqtt-dali.schema.json", root / CONFED_SCHEMA_PATH)


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

    def __init__(  # pylint: disable=too-many-arguments
        self,
        transport: RegisterTransport,
        serial_config: dict,
        config: Optional[dict] = None,
        vendor_dir: Optional[Path] = None,
        root: Path = Path("/"),
        groups: Optional[Dict[str, List[int]]] = None,
    ) -> None:
        self.broker = Broker()
        self.transport = transport
        # Config only: the daemon discovers its modules through config/Load,
        # and reaches them itself through the register link below.
        self.serial = FakeWbMqttSerial(self.broker, None, serial_config)
        self.groups_seed = groups
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
        # A failure partway through leaves live tasks behind — the dispatcher,
        # the serial stub, and (because `Gateway.start` gathers bus startups
        # with return_exceptions before re-raising) possibly a polling loop
        # already driving the port. `stop()` tolerates a partial start, so a
        # failed boot tears down whatever got up instead of orphaning it.
        try:
            return await self._start()
        except BaseException:
            try:
                await self.stop()
            except Exception:  # pylint: disable=broad-exception-caught
                logger.exception("Cleanup after a failed start also failed")
            raise

    async def _start(self) -> "DaliRuntime":
        from wb.mqtt_dali.gateway import Gateway
        from wb.mqtt_dali.gtin_db import DaliDatabase
        from wb.mqtt_dali.mqtt_dispatcher import MQTTDispatcher

        if self.vendor_dir is not None:
            install_data_files(self.vendor_dir, self.root)
        # The daemon reads its schemas from here; under a shifted root that is
        # where install_data_files put them, in the browser it is the tarball.
        os.environ[DATA_DIR_ENV] = str(self.root / DATA_DIR)
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
            driver_factory=self._make_driver,
        )
        await self.gateway.start()
        seeded = self._seed_groups(self.groups_seed or {})
        await self._wait_for_configured_devices(already_seeded=seeded)
        logger.info("wb-mqtt-dali is running")
        return self

    def _make_driver(self, config, mqtt_dispatcher, driver_logger, dev_inst_map) -> WBDALIDriver:
        """The daemon's driver over this host's Modbus access.

        No memory memo: every read goes to the bus. Withdrawn pending the
        provenance design (SOFT-7409) — cached values must be labeled as
        cached in the UI before they are served again.
        """
        link = RegisterLink(config, self.transport, driver_logger)
        return WBDALIDriver(config, mqtt_dispatcher, driver_logger, dev_inst_map, link=link)

    def _controllers(self):
        return [controller for wb_dali_gateway in self.gateway.wb_dali_gateways for controller in wb_dali_gateway.buses]

    def _all_devices(self):
        return [
            device for controller in self._controllers() for device in controller.dali_devices + controller.dali2_devices
        ]

    def _seed_groups(self, groups_by_mqtt_id: Dict[str, List[int]]) -> set:
        """Give devices last session's group membership before anyone reads it.

        Groups are not in the config file — they live on the gear, and the
        daemon reads them during device initialization, tens of seconds of bus
        traffic after boot. The page reads its device tree once, as soon as the
        daemon answers, so without this it would show the installation
        groupless. The seed is what the previous session saw; initialization
        still reads the truth off the bus afterwards and corrects the daemon's
        state, exactly as it would have.

        Returns the mqtt ids that were seeded.
        """
        seeded = set()
        for device in self._all_devices():
            seed = groups_by_mqtt_id.get(device.mqtt_id)
            if seed is None or not hasattr(device, "seed_groups"):
                continue
            if not device.is_initialized:
                device.seed_groups(seed)
            # Either way the page shows this device correctly: the bus has
            # answered, or last session's copy stands in until it does.
            seeded.add(device.mqtt_id)
        return seeded

    def snapshot_groups(self) -> Dict[str, List[int]]:
        """Each device's group membership, for the page to keep across reloads."""
        return {
            device.mqtt_id: sorted(device.groups)
            for device in self._all_devices()
            if hasattr(device, "groups")
        }

    async def _wait_for_configured_devices(self, already_seeded: set = frozenset()) -> None:
        """Hold "ready" until every unseeded configured device has been tried once.

        The web UI reads the device tree exactly once, when its page mounts, and
        only rebuilds it from a commissioning run. A device seeded with last
        session's groups already shows correctly, so it is not worth waiting
        for; one with no seed would show groupless until a rescan, which is
        worth a slower boot to avoid. In the common case every device is seeded
        and this returns at once.

        A device that does not answer must not hold the page hostage, so this
        gives up after a deadline and boots with whatever has come up; the
        stragglers keep initializing behind the page as they would have anyway.
        """
        waiting = [
            controller
            for controller in self._controllers()
            if any(
                device.mqtt_id not in already_seeded
                for device in controller.dali_devices + controller.dali2_devices
            )
        ]
        if not waiting:
            return
        count = sum(
            1 for device in self._all_devices() if device.mqtt_id not in already_seeded
        )
        # Reading five devices' worth of identity and groups takes tens of
        # seconds at DALI speed, and the boot screen shows this log as it
        # happens — so say what the time is being spent on.
        logger.info("Reading %d configured DALI device(s) from the bus...", count)
        try:
            await asyncio.wait_for(
                asyncio.gather(*(controller.wait_first_init_attempts() for controller in waiting)),
                FIRST_ATTEMPTS_DEADLINE_S,
            )
        except asyncio.TimeoutError:
            pass
        pending = [
            device.name
            for device in self._all_devices()
            if device.mqtt_id not in already_seeded and not device.is_initialized
        ]
        if pending:
            logger.warning(
                "Booting with %d device(s) still initializing: %s", len(pending), ", ".join(pending)
            )

    async def stop(self) -> None:
        if hasattr(self.transport, "stop"):
            self.transport.stop()
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
                except Exception:  # pylint: disable=broad-exception-caught
                    # A task that already died re-raises its own exception
                    # here; teardown must still detach the clients and stop
                    # the serial stub, or a restart inherits both.
                    logger.exception("Task %s failed before stop()", task.get_name())
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
        payload = get_str_payload(message)
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
            callback(message.topic.value, get_str_payload(message), True)

    def unsubscribe(self, pattern: str) -> None:
        """Drop every UI callback for a filter, matching homeui's mqttClient."""
        if self._subscriptions.pop(pattern, None) is not None and self._ui_client is not None:
            self._ui_client.remove_filter(pattern)

    def publish(self, topic: str, payload: Any = None, retain: bool = False, qos: int = 1) -> None:
        self.broker.publish(topic, payload, qos=qos, retain=retain)

    # -- persistence ------------------------------------------------------

    def installation_is_fresh(self) -> bool:
        """Whether no bus of any gateway has a single configured device yet.

        Read from the config file, not the boot-time dict: the daemon rewrites
        the file as scans complete, and this must reflect that.
        """
        try:
            config = json.loads(self.read_config())
        except ValueError:
            config = self.config
        return all(
            not bus.get("devices")
            for gateway in config.get("gateways", [])
            for bus in gateway.get("buses", [])
        )

    async def scan_all_buses(self) -> None:
        """Scan every bus of every gateway, one at a time.

        Meant for the first open of a freshly found gateway: nothing is
        configured, and asking the operator to visit three bus pages and press
        Rescan on each is make-work the daemon can do by itself. Sequential
        because the buses share one serial link — interleaving two
        commissionings would double both their wall-clock times.

        The page needs no special handling: it subscribes to the commissioning
        topics when it mounts, shows each bus's progress bar, and rebuilds the
        tree from the completed message exactly as for an operator-started scan.
        """
        for gateway in self.config.get("gateways", []):
            for bus_number in range(1, 1 + len(gateway.get("buses", []))):
                bus_id = f"{gateway['device_id']}_bus_{bus_number}"
                try:
                    await self.rpc("Editor", "ScanBus", {"busId": bus_id})
                except Exception:  # pylint: disable=broad-exception-caught
                    logger.exception("Automatic scan of %s failed to start", bus_id)
                    continue
                try:
                    await asyncio.wait_for(self.gateway.wait_commissioning(bus_id), COMMISSIONING_DEADLINE_S)
                except asyncio.TimeoutError:
                    logger.warning("Automatic scan of %s did not finish in time", bus_id)

    def watch_config(self, callback: Callable[[str, str], None]) -> None:
        """Report the config and the group snapshot when either changes.

        The browser's filesystem does not survive a reload, so the page has to
        keep the config itself. The daemon says when it writes the config
        (`Gateway.on_config_saved`); the group snapshot changes as
        initialization reads the bus, which touches no file and
        answers no RPC — so the events that follow those are watched too, and a
        report goes out only when the contents actually differ.
        """

        def snapshot() -> tuple:
            return (
                self.read_config(),
                json.dumps(self.snapshot_groups()),
            )

        last: List[tuple] = [snapshot()]

        def check(*_args) -> None:
            current = snapshot()
            if current[0] and current != last[0]:
                last[0] = current
                callback(*current)

        self.gateway.on_config_saved(check)
        self.subscribe("/rpc/v1/wb-mqtt-dali/+/+/+/reply", check)
        self.subscribe("/wb-dali/+/commissioning", check)
        self.subscribe("/devices/+/meta", check)

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
