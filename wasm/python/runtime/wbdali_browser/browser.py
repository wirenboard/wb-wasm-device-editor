"""The API the Pyodide worker calls.

Everything the web page can do is here: boot the daemon over a simulated
installation, then publish and subscribe. Keeping the surface to MQTT means the
page runs the same code against this as homeui runs against a real controller.

Called from JavaScript, so arguments arrive as JsProxy objects and have to be
converted before Python touches them.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .hardware import WasmSerialTransport
from .runtime import DaliRuntime, default_config
from .scenario import (
    build_network,
    default_scenario,
    export_scenario,
    serial_config,
    serial_settings,
    slave_ids,
)

logger = logging.getLogger("wbdali_browser")

SIMULATED = "simulated"
HARDWARE = "hardware"

_runtime: Optional[DaliRuntime] = None
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
    scenario_json: Optional[str] = None,
    config_json: Optional[str] = None,
    mode: str = SIMULATED,
    port_load: Optional[Callable] = None,
) -> str:
    """Boot wb-mqtt-dali over a simulated installation or real hardware.

    `mode` picks which `RegisterTransport` sits under the DALI driver: the
    simulated WB-DALI modules described by the scenario, or real ones reached
    through the C++ WASM module's `port/Load` RPC over WebSerial. Everything
    above the transport is identical either way.

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

    _scenario = json.loads(scenario_json) if scenario_json else default_scenario()
    gateway_ids = [gateway["id"] for gateway in _scenario.get("gateways", [])]

    runtime = DaliRuntime(
        transport=_make_transport(mode, port_load),
        serial_config=serial_config(_scenario),
        config=_restore_config(config_json, gateway_ids) or default_config(gateway_ids),
        root=Path("/"),
    )
    # Only publish the runtime once it is up: a failed start would otherwise
    # leave a half-built one for the next call to stop().
    await runtime.start()
    _runtime = runtime
    return json.dumps(_scenario)


def _make_transport(mode: str, port_load: Optional[Callable]):
    if mode == SIMULATED:
        return build_network(_scenario)
    if mode != HARDWARE:
        raise ValueError(f"unknown transport mode {mode!r}")
    if port_load is None:
        raise ValueError("hardware mode needs a port_load callable")

    async def call_port_load(request: Dict[str, Any]) -> Dict[str, Any]:
        # JSON both ways: the JS side hands back a string rather than a JsProxy,
        # so nothing here has to know about Pyodide's conversion rules.
        return json.loads(await port_load(json.dumps(request)))

    return WasmSerialTransport(
        call_port_load, slave_ids(_scenario), serial_settings(_scenario)
    )


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


def watch_config(callback: Callable[[str], None]) -> None:
    """Report the daemon's config whenever it changes, so the page can keep it."""
    _require().watch_config(callback)


def snapshot_scenario() -> str:
    """The simulated installation as it stands now, short addresses included.

    Returns the scenario unchanged in hardware mode: the state that matters
    lives in the modules themselves, and the daemon's config already records it.
    """
    transport = _require().transport
    if not hasattr(transport, "gateways"):
        return json.dumps(_scenario)
    return json.dumps(export_scenario(_scenario, transport))


async def stop() -> None:
    global _runtime  # pylint: disable=global-statement

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
    """A snapshot of what the simulation is doing, for the page's debug panel."""
    runtime = _require()
    network = runtime.transport
    return json.dumps(
        {
            "messagesPublished": runtime.broker.published_count,
            "mode": SIMULATED if hasattr(network, "gateways") else HARDWARE,
            "gateways": {
                device_id: {
                    "framesSent": gateway.frames_sent,
                    "reachable": gateway.reachable,
                    "buses": {
                        str(index): {
                            "gear": len(bus.dali_bus.gear),
                            "devices": len(bus.dali_bus.devices),
                            "framesSeen": bus.dali_bus.frames_seen,
                        }
                        for index, bus in gateway.buses.items()
                    },
                }
                for device_id, gateway in getattr(network, "gateways", {}).items()
            },
        }
    )


def set_gateway_reachable(device_id: str, reachable: bool) -> None:
    """Pull the plug on a simulated module, so the UI's error paths can be seen."""
    gateways = getattr(_require().transport, "gateways", None)
    if gateways is None:
        raise RuntimeError("only a simulated module can be unplugged from here")
    gateways[device_id].reachable = reachable


def _require() -> DaliRuntime:
    if _runtime is None:
        raise RuntimeError("wb-mqtt-dali is not running; call start() first")
    return _runtime
