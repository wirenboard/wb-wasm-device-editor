"""What the daemon does after a scan, when nobody is looking.

`ApplicationController` polls every initialised device continuously, and a poll
that raises is retried on the next pass — about once a millisecond. So a device
the simulator models badly does not merely report wrong values: it becomes an
unbounded error loop, which in a browser is enough to wedge the tab the runtime
runs in.
"""

import asyncio
import json
import logging
from pathlib import Path

import pytest

from wbdali_browser.runtime import DaliRuntime, default_config
from wbdali_browser.scenario import build_network, default_scenario, serial_config

from .conftest import GATEWAY_DEVICE_ID
from .test_runtime_editor_rpc import wait_for_commissioning

VENDOR_DIR = Path(__file__).parent.parent / "vendor"

SETTLE_SECONDS = 2.0


class ErrorRecorder(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.ERROR)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


@pytest.fixture
async def scanned_runtime(tmp_path):
    scenario = default_scenario()
    network = build_network(scenario)
    runtime = DaliRuntime(
        transport=network,
        serial_config=serial_config(scenario),
        config=default_config([GATEWAY_DEVICE_ID]),
        vendor_dir=VENDOR_DIR,
        root=tmp_path,
    )
    await runtime.start()
    try:
        progress = []
        runtime.subscribe(
            f"/wb-dali/{GATEWAY_DEVICE_ID}_bus_1/commissioning",
            lambda _topic, payload, _retain: progress.append(json.loads(payload)) if payload else None,
        )
        await runtime.rpc("Editor", "ScanBus", {"busId": f"{GATEWAY_DEVICE_ID}_bus_1"})
        await wait_for_commissioning(progress)
        runtime.commissioning = progress[-1]
        yield runtime
    finally:
        await runtime.stop()


async def test_the_default_installation_is_found_in_full(scanned_runtime):
    final = scanned_runtime.commissioning

    assert final["status"] == "completed"
    # Four luminaires and one wall switch: two of the luminaires are
    # factory-fresh and one is a colour driver, so the scan covers both halves
    # of commissioning and both device families.
    assert final["device_count"] == 5


async def test_polling_a_scanned_bus_raises_nothing(scanned_runtime):
    recorder = ErrorRecorder()
    logging.getLogger().addHandler(recorder)
    try:
        await asyncio.sleep(SETTLE_SECONDS)
    finally:
        logging.getLogger().removeHandler(recorder)

    assert recorder.messages == []
