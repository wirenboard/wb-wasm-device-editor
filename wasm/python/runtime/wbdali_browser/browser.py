"""The API the Pyodide worker calls.

Everything the web page can do is here: boot the daemon over a simulated
installation, then publish and subscribe. Keeping the surface to MQTT means the
page runs the same code against this as homeui runs against a real controller.

Called from JavaScript, so arguments arrive as JsProxy objects and have to be
converted before Python touches them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .hardware import WasmSerialTransport
from .runtime import DaliRuntime, default_config
from .scenario import serial_config, serial_settings, slave_ids

logger = logging.getLogger("wbdali_browser")

_runtime: Optional[DaliRuntime] = None
_auto_scan_task = None
_scenario: Dict[str, Any] = {}


def configure_logging(level: str = "INFO") -> None:
    """Send the daemon's logs to the worker's console.

    Without a handler, `logging` writes to stderr, which Pyodide already routes
    to the console — but at WARNING and above only, so the interesting parts of a
    bus scan would be invisible.
    """
    handler = logging.StreamHandler(sys.stdout)
    # The level leads the line so the page can tell an error from a warning
    # without pattern-matching the message.
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # The bus driver logs one line per frame at DEBUG; a scan is thousands of
    # frames, and each line costs a postMessage to the page.
    logging.getLogger("wbdali_browser.sim").setLevel(logging.INFO)


async def start(
    scenario_json: str,
    config_json: Optional[str] = None,
    groups_json: Optional[str] = None,
    memory_json: Optional[str] = None,
    port_load: Optional[Callable] = None,
) -> str:
    """Boot wb-mqtt-dali against the WB-DALI modules the Modbus scan found.

    The scenario names the gateways and the line settings they answered on;
    they are reached through the C++ WASM module's `port/Load` RPC over
    WebSerial.

    `config_json` restores a previously saved daemon config, so an installation
    commissioned before a page reload comes back instead of looking untouched.
    It is only honoured when it describes the same gateways as the scenario:
    `Gateway._update_gateways` deletes any gateway the serial config does not
    list, and would silently discard a mismatched one.

    Returns the scenario actually used, as JSON.
    """
    global _runtime, _scenario  # pylint: disable=global-statement

    if _runtime is not None:
        await stop()
    if port_load is None:
        raise ValueError("start() needs a port_load callable")

    _scenario = json.loads(scenario_json)
    gateway_ids = [gateway["id"] for gateway in _scenario.get("gateways", [])]

    async def call_port_load(request: Dict[str, Any]) -> Dict[str, Any]:
        # JSON both ways: the JS side hands back a string rather than a JsProxy,
        # so nothing here has to know about Pyodide's conversion rules.
        return json.loads(await port_load(json.dumps(request)))

    runtime = DaliRuntime(
        transport=WasmSerialTransport(
            call_port_load, slave_ids(_scenario), serial_settings(_scenario)
        ),
        serial_config=serial_config(_scenario),
        config=_restore_config(config_json, gateway_ids) or default_config(gateway_ids),
        root=Path("/"),
        groups=_restore_groups(groups_json),
        memory=_restore_memory(memory_json),
    )
    # Only publish the runtime once it is up: a failed start would otherwise
    # leave a half-built one for the next call to stop().
    await runtime.start()
    _runtime = runtime

    # A gateway nobody has configured yet gets scanned without being asked:
    # the alternative is a tree of three empty buses and an operator hunting
    # for the Rescan button on each. In the background — the page is usable
    # while it runs, and shows each bus's progress as it would for a manual
    # scan.
    global _auto_scan_task  # pylint: disable=global-statement
    if runtime.installation_is_fresh():
        _auto_scan_task = asyncio.create_task(
            runtime.scan_all_buses(), name="dali-auto-scan"
        )

    return json.dumps(_scenario)


def _restore_config(config_json: Optional[str], gateway_ids: list) -> Optional[dict]:
    if not config_json:
        return None
    try:
        config = json.loads(config_json)
    except ValueError:
        logger.warning("Saved DALI config is not valid JSON; starting fresh")
        return None
    saved_ids = [gateway.get("device_id") for gateway in config.get("gateways", [])]
    if sorted(saved_ids) != sorted(gateway_ids):
        logger.info("Saved DALI config is for a different installation; starting fresh")
        return None
    return config


def _restore_groups(groups_json: Optional[str]) -> Optional[dict]:
    if not groups_json:
        return None
    try:
        groups = json.loads(groups_json)
    except ValueError:
        logger.warning("Saved DALI group state is not valid JSON; ignoring it")
        return None
    if not isinstance(groups, dict):
        return None
    restored = {}
    for mqtt_id, indexes in groups.items():
        if not isinstance(indexes, list):
            continue
        try:
            restored[str(mqtt_id)] = [int(index) for index in indexes]
        except (TypeError, ValueError):
            # One malformed entry costs that device its seed, not the boot —
            # and certainly not the whole saved installation, which is what a
            # boot failure escalates to after two strikes.
            logger.warning("Ignoring malformed group seed for %r", mqtt_id)
    return restored


def _restore_memory(memory_json: Optional[str]) -> Optional[dict]:
    if not memory_json:
        return None
    try:
        memory = json.loads(memory_json)
    except ValueError:
        logger.warning("Saved DALI memory-bank state is not valid JSON; ignoring it")
        return None
    # Per-entry validation happens in MemoryCache, which skips what it cannot
    # read; a malformed seed costs at most a re-read, never the boot.
    return memory if isinstance(memory, dict) else None


def watch_config(callback: Callable[[str, str, str], None]) -> None:
    """Report the daemon's config whenever it changes, so the page can keep it.

    The callback also receives the group-membership snapshot as JSON: groups are
    not in the config file, and losing them across a reload is what makes a
    restored installation open groupless.
    """
    _require().watch_config(callback)


def snapshot_scenario() -> str:
    """The scenario the runtime was started with.

    Stored alongside the config so a reload can tell whether the saved config
    still belongs to the gateways it will boot against. Nothing in it changes at
    runtime: the state that matters lives in the modules themselves, and the
    daemon's config already records it.
    """
    return json.dumps(_scenario)


async def stop() -> None:
    global _runtime, _auto_scan_task  # pylint: disable=global-statement

    if _auto_scan_task is not None:
        _auto_scan_task.cancel()
        try:
            await _auto_scan_task
        except (asyncio.CancelledError, Exception):  # pylint: disable=broad-exception-caught
            pass
        _auto_scan_task = None
    if _runtime is not None:
        await _runtime.stop()
        _runtime = None


def publish(topic: str, payload: str, retain: bool = False, qos: int = 1) -> None:
    _require().publish(topic, payload, retain=retain, qos=qos)


def subscribe(pattern: str, callback: Callable[[str, str, bool], None]) -> None:
    _require().subscribe(pattern, callback)


def unsubscribe(pattern: str) -> None:
    _require().unsubscribe(pattern)


async def rpc(service: str, method: str, params_json: Optional[str] = None) -> str:
    """Call one RPC method directly. The page uses MQTT-RPC; this is for the console."""
    params = json.loads(params_json) if params_json else {}
    return json.dumps(await _require().rpc(service, method, params))


def diagnostics() -> str:
    """A snapshot of what the runtime is doing, for the page's debug console."""
    runtime = _require()
    return json.dumps({"messagesPublished": runtime.broker.published_count})


def _require() -> DaliRuntime:
    if _runtime is None:
        raise RuntimeError("wb-mqtt-dali is not running; call start() first")
    return _runtime
