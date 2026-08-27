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

from .runtime import DaliRuntime, default_config
from .scenario import build_network, default_scenario, serial_config

logger = logging.getLogger("wbdali_browser")

_runtime: Optional[DaliRuntime] = None


def configure_logging(level: str = "INFO") -> None:
    """Send the daemon's logs to the worker's console.

    Without a handler, `logging` writes to stderr, which Pyodide already routes
    to the console — but at WARNING and above only, so the interesting parts of a
    bus scan would be invisible.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # The bus driver logs one line per frame at DEBUG; a scan is thousands of
    # frames, and each line costs a postMessage to the page.
    logging.getLogger("wbdali_browser.sim").setLevel(logging.INFO)


async def start(scenario_json: Optional[str] = None) -> str:
    """Boot wb-mqtt-dali over a simulated installation.

    Returns the scenario actually used, as JSON, so the page can show what it got.
    """
    global _runtime  # pylint: disable=global-statement

    if _runtime is not None:
        await stop()

    scenario: Dict[str, Any] = json.loads(scenario_json) if scenario_json else default_scenario()
    network = build_network(scenario)
    gateway_ids = [gateway["id"] for gateway in scenario.get("gateways", [])]

    _runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config(scenario),
        config=default_config(gateway_ids),
        root=Path("/"),
    )
    network.bind(_runtime.serial.publish_control)
    await _runtime.start()
    return json.dumps(scenario)


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
    network = runtime.serial.transport
    return json.dumps(
        {
            "messagesPublished": runtime.broker.published_count,
            "gateways": {
                device_id: {
                    "framesSent": gateway.frames_sent,
                    "reachable": gateway.reachable,
                    "buses": {
                        str(index): {
                            "gear": len(bus.dali_bus.gear),
                            "devices": len(bus.dali_bus.devices),
                            "framesSeen": len(bus.dali_bus.history),
                        }
                        for index, bus in gateway.buses.items()
                    },
                }
                for device_id, gateway in getattr(network, "gateways", {}).items()
            },
        }
    )


def set_gateway_reachable(device_id: str, reachable: bool) -> None:
    """Pull the plug on a module, so the UI's error paths can be seen."""
    runtime = _require()
    gateway = runtime.serial.transport.gateways[device_id]
    gateway.reachable = reachable
    runtime.serial.publish_availability(device_id, reachable)


def _require() -> DaliRuntime:
    if _runtime is None:
        raise RuntimeError("wb-mqtt-dali is not running; call start() first")
    return _runtime
