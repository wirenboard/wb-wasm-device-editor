"""The daemon must import with only the vendored sources and the browser shims.

Anything that resolves to a system site-packages copy here would work on this
machine and fail in Pyodide, so every module is checked for where it came from.
"""

import subprocess
import sys
from pathlib import Path

import pytest

VENDOR = str(Path(__file__).parent.parent / "vendor")
SHIMS = str(Path(__file__).parent.parent / "shims")
RUNTIME = str(Path(__file__).parent.parent / "runtime")

DAEMON_MODULES = [
    "wb.mqtt_dali.gateway",
    "wb.mqtt_dali.commissioning",
    "wb.mqtt_dali.wbdali",
    "wb.mqtt_dali.application_controller",
    "wb.mqtt_dali.mqtt_dispatcher",
    "wb.mqtt_dali.mqtt_rpc_server",
    "wb.mqtt_dali.mqtt_rpc_client",
    "wb.mqtt_dali.send_command",
    "wb.mqtt_dali.settings",
    "wb.mqtt_dali.gtin_db",
]

DALI_MODULES = [
    "dali.command",
    "dali.gear.general",
    "dali.gear.colour",
    "dali.device.general",
    "dali.sequences",
    "dali.memory.info",
    "dali.tests.fakes",
]


@pytest.mark.parametrize("name", DAEMON_MODULES + DALI_MODULES)
def test_module_imports_from_vendor(name):
    module = __import__(name, fromlist=["__file__"])
    assert module.__file__.startswith(VENDOR), f"{name} came from {module.__file__}"


@pytest.mark.parametrize("name", ["aiomqtt", "websockets", "wb_common.mqtt_client"])
def test_shimmed_module_is_ours(name):
    module = __import__(name, fromlist=["__file__"])
    assert module.__file__.startswith(SHIMS), f"{name} came from {module.__file__}"


def test_aiomqtt_shim_exposes_what_the_daemon_uses():
    import aiomqtt

    assert {"Message", "Client", "MqttError"} <= set(dir(aiomqtt))


def test_no_networking_module_is_pulled_in():
    """No hardware or network client library may be pulled in.

    `socket`/`ssl`/`threading` are excluded from the check: `logging` and
    `asyncio` import them from the stdlib, and Pyodide ships both. What must not
    appear is a third-party driver or client that expects a real device or a
    real connection. (`jsonschema.validators` pulls in `urllib.request` for
    remote $ref resolution; we never use remote refs, and the module itself is
    in Pyodide's stdlib.)

    Run in a fresh interpreter — this test process has pytest loaded, which
    drags in half of the networking stdlib on its own.
    """
    program = (
        "import sys;"
        f"sys.path[:0] = [{SHIMS!r}, {RUNTIME!r}, {VENDOR!r}];"
        f"[__import__(n) for n in {DAEMON_MODULES + DALI_MODULES!r}];"
        "forbidden = {'serial', 'usb', 'hid', 'pymodbus', 'serial_asyncio',"
        " 'paho.mqtt.client', 'aiomqtt.client', 'requests'};"
        "print(sorted(forbidden & set(sys.modules)))"
    )
    result = subprocess.run(
        [sys.executable, "-c", program], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "[]", result.stdout
