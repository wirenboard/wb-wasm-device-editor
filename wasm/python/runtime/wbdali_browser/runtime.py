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
        groups: Optional[Dict[str, List[int]]] = None,
        memory: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.broker = Broker()
        self.transport = transport
        self.serial = WbMqttSerialConfigService(self.broker, serial_config)
        self.groups_seed = groups
        self.memory_seed = memory
        self.memory_caches: Dict[tuple, Any] = {}
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
        from wb.mqtt_dali import application_controller
        from wb.mqtt_dali.gateway import Gateway
        from wb.mqtt_dali.gtin_db import DaliDatabase
        from wb.mqtt_dali.mqtt_dispatcher import MQTTDispatcher

        # `ApplicationController` builds its own DALI driver, handing it the MQTT
        # dispatcher it would use to reach wb-mqtt-serial. Substituting the name
        # it constructs is the whole adaptation: the browser talks to the gateway
        # over Modbus registers instead, one blocking request at a time.
        application_controller.WBDALIDriver = make_driver_class(
            self.transport, self.memory_caches, self.memory_seed
        )
        install_bus_monitor_polling(application_controller.ApplicationController)

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
        seeded = self._seed_groups(self.groups_seed or {})
        await self._wait_for_configured_devices(already_seeded=seeded)
        self._update_monitor_pacing()
        logger.info("wb-mqtt-dali is running")
        return self

    def _update_monitor_pacing(self) -> None:
        """Tell each bus driver whether anything on its bus speaks unprompted.

        A bus with DALI-2 control devices needs its monitor ring read briskly
        even when nobody watches — sensor events are the daemon's data path.
        A bus of plain gear does not, and its driver can relax the idle poll.
        Re-run after config changes: a rescan can add or remove the sensors.
        """
        if self.gateway is None:
            return
        for wb_dali_gateway in self.gateway.wb_dali_gateways:
            for controller in wb_dali_gateway.buses:
                controller.driver.set_has_control_devices(bool(controller.dali2_devices))

    def _all_devices(self):
        return [
            device
            for wb_dali_gateway in self.gateway.wb_dali_gateways
            for controller in wb_dali_gateway.buses
            for device in controller.dali_devices + controller.dali2_devices
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
            parameter = getattr(device, "_groups_parameter", None)
            if seed is None or parameter is None:
                continue
            if device.is_initialized:
                # The bus has already answered; last session's copy is the
                # stale one now.
                seeded.add(device.mqtt_id)
                continue
            indexes = {index for index in seed if 0 <= index < len(parameter._groups)}
            parameter._group_indexes = indexes
            parameter._groups = [index in indexes for index in range(len(parameter._groups))]
            seeded.add(device.mqtt_id)
        return seeded

    def snapshot_memory(self) -> Dict[str, Any]:
        """Every bus's memory-bank memo, keyed by the random address each device
        answered with — what the next session verifies before trusting a byte."""
        return {
            f"{device_name}_bus_{bus}": cache.snapshot()
            for (device_name, bus), cache in self.memory_caches.items()
        }

    def snapshot_groups(self) -> Dict[str, List[int]]:
        """Each device's group membership, for the page to keep across reloads."""
        return {
            device.mqtt_id: sorted(device.groups)
            for device in self._all_devices()
            if hasattr(device, "groups")
        }

    async def _wait_for_configured_devices(self, already_seeded: set = frozenset()) -> None:
        """Hold "ready" until unseeded configured devices have initialized.

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
        devices = [
            device for device in self._all_devices() if device.mqtt_id not in already_seeded
        ]
        if not devices:
            return
        # Reading five devices' worth of identity and groups takes tens of
        # seconds at DALI speed, and the boot screen shows this log as it
        # happens — so say what the time is being spent on, one line per device.
        logger.info("Reading %d configured DALI device(s) from the bus...", len(devices))
        deadline = asyncio.get_running_loop().time() + 30.0
        reported: set = set()
        while True:
            for device in devices:
                # Keyed on mqtt_id: names repeat (the default is "DALI <short>"
                # with no bus in it), and a duplicate would stall the wait at
                # the deadline for devices that are already up.
                if device.is_initialized and device.mqtt_id not in reported:
                    reported.add(device.mqtt_id)
                    logger.info("  %s is up (%d/%d)", device.name, len(reported), len(devices))
            if len(reported) == len(devices):
                return
            if asyncio.get_running_loop().time() > deadline:
                logger.warning(
                    "Booting with %d device(s) still initializing: %s",
                    len(devices) - len(reported),
                    ", ".join(
                        device.name for device in devices if device.mqtt_id not in reported
                    ),
                )
                return
            await asyncio.sleep(0.1)

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
                await self._wait_for_commissioning_to_finish(bus_id)

    async def _wait_for_commissioning_to_finish(self, bus_id: str) -> None:
        # 120 s: a populated bus takes ~20 s on real hardware; the rest is
        # headroom for a bus full of unaddressed gear.
        deadline = asyncio.get_running_loop().time() + 120.0
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.5)
            try:
                gateways = await self.rpc("Editor", "GetList")
            except Exception:  # pylint: disable=broad-exception-caught
                logger.exception("Polling commissioning state of %s failed", bus_id)
                return
            for gateway in gateways:
                for bus in gateway.get("buses", []):
                    if bus.get("id") != bus_id:
                        continue
                    # In-progress states carry the stage name (queued,
                    # binary_search, read_device_info, dali2_* …), so wait for
                    # a terminal one rather than guessing at the rest.
                    status = bus.get("commissioning", {}).get("status")
                    if status in ("idle", "completed", "failed", "cancelled"):
                        return
        logger.warning("Automatic scan of %s did not finish in time", bus_id)

    def watch_config(self, callback: Callable[[str, str, str], None]) -> None:
        """Report the daemon's config, and the group snapshot, when either changes.

        The browser's filesystem does not survive a reload, so the page has to
        keep the config itself. Rather than polling, this watches the events
        that can follow a change — an `Editor/*` reply, a commissioning state
        change, and the device topics the daemon publishes as it initializes
        and polls — and reports only when the contents actually differ. The
        daemon rewrites the config on boot, on every GetList, on SetBus,
        SetGateway and ResetDevice, and when a scan completes; the group
        snapshot changes when initialization reads membership off the bus,
        which touches no file and answers no RPC — that is what the device
        topics are subscribed for.
        """
        def snapshot() -> tuple:
            return (
                self.read_config(),
                json.dumps(self.snapshot_groups()),
                json.dumps(self.snapshot_memory(), sort_keys=True),
            )

        last: List[tuple] = [snapshot()]

        def check(_topic: str, _payload: str, _retained: bool) -> None:
            current = snapshot()
            if current[0] and current != last[0]:
                last[0] = current
                # The same events that change the config change what lives on
                # the buses — retune the ring polling along with the report.
                self._update_monitor_pacing()
                callback(*current)

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


def install_bus_monitor_polling(controller_class) -> None:
    """Let the bus monitor toggle start and stop the driver's ring polling.

    On a controller the monitor needs nothing from the driver: wb-mqtt-serial
    streams the ring as sporadic events and the flag only decides whether the
    daemon republishes them. Here the ring has to be read, which costs serial
    traffic — so the same flag has to reach the driver.

    Two wrappers rather than a subclass: `Gateway` constructs these itself, from
    two places, and both would have to be substituted.
    """
    if getattr(controller_class, "_bus_monitor_polling_installed", False):
        return

    original_start = controller_class.start
    original_set = controller_class.set_bus_monitor_enabled

    async def start(self):
        await original_start(self)
        self._dev.set_bus_monitor_enabled(self.bus_monitor_enabled)

    def set_bus_monitor_enabled(self, enabled: bool) -> None:
        original_set(self, enabled)
        self._dev.set_bus_monitor_enabled(enabled)

    controller_class.start = start
    controller_class.set_bus_monitor_enabled = set_bus_monitor_enabled
    controller_class._bus_monitor_polling_installed = True
