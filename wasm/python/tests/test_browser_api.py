"""The JavaScript-facing API, exercised the way dali-runtime.ts calls it.

`browser.start()` takes positional arguments — scenario, config, groups,
memory, port_load — and the TS boot message hands them over in that order.
Nothing else pins that order, so this does, along with the JSON envelope the
port_load bridge speaks and the three-part watch_config callback.
"""

import asyncio
import json
import os
import shutil
from pathlib import Path

from wbdali_browser import browser
from wbdali_browser.hardware import hex_to_registers, registers_to_hex
from wb.mqtt_dali.sim.control_gear import SimulatedControlGear
from wb.mqtt_dali.sim.dali_bus import SimulatedDaliBus
from wb.mqtt_dali.sim.network import SimulatedModbusNetwork

VENDOR_DIR = Path(__file__).parent.parent / "vendor"
GATEWAY = "wb-dali_17"
SLAVE_ID = 17


def scenario_json():
    return json.dumps({
        "gateways": [{"id": GATEWAY, "slaveId": SLAVE_ID, "buses": {"1": {}, "2": {}, "3": {}}}],
        "serialSettings": {"baud_rate": 115200, "data_bits": 8, "parity": "N", "stop_bits": 2},
    })


def make_port_load(network):
    """`Module.request('portLoad')` as the JS side proxies it: JSON in, JSON out,
    the reply wrapped in the JSON-RPC envelope with the payload under `result`."""

    async def port_load(request_json):
        request = json.loads(request_json)
        assert request["slave_id"] == SLAVE_ID
        function = request["function"]
        if function in (6, 16):
            network.gateways[GATEWAY].write_holding(request["address"], hex_to_registers(request["msg"]))
            return json.dumps({"error": None, "result": {"response": ""}})
        if function == 4:
            registers = network.gateways[GATEWAY].read_input(request["address"], request["count"])
            return json.dumps({"error": None, "result": {"response": registers_to_hex(registers)}})
        return json.dumps({"error": {"message": f"unsupported function {function}"}})

    return port_load


async def test_start_takes_the_arguments_in_the_order_dali_runtime_ts_passes_them(tmp_path):
    network = SimulatedModbusNetwork()
    buses = {index: SimulatedDaliBus() for index in (1, 2, 3)}
    buses[1].add_gear(SimulatedControlGear(shortaddr=0, random_address=0x100000, groups={3}))
    network.add_module(GATEWAY, buses)

    config = {
        "debug": False,
        "gateways": [{
            "device_id": GATEWAY,
            "buses": [{"devices": [{"short": 0, "random": 0x100000, "name": "lamp"}]}, {"devices": []}, {"devices": []}],
        }],
    }
    groups = {f"{GATEWAY}_bus_1_0": [3]}

    # browser.start() writes to /etc and /usr/share of its root — redirect it.
    os.makedirs(tmp_path / "usr/share", exist_ok=True)
    original_root = browser.Path
    try:
        from wbdali_browser import runtime as runtime_module
        runtime_module.install_data_files(VENDOR_DIR, tmp_path)
        browser.Path = lambda _: tmp_path  # type: ignore[assignment]

        applied = await browser.start(
            scenario_json(),
            json.dumps(config),
            json.dumps(groups),
            None,  # memory: nothing remembered yet
            make_port_load(network),
        )
        assert json.loads(applied)["gateways"][0]["id"] == GATEWAY

        gateways = await browser.rpc("Editor", "GetList")
        gateways = json.loads(gateways)
        assert gateways[0]["buses"][0]["devices"][0]["groups"] == [3]

        reports = []
        browser.watch_config(lambda config_text, groups_json, memory_json: reports.append(
            (json.loads(config_text), json.loads(groups_json), json.loads(memory_json))
        ))
        # A device-page open reads the memory banks, which the watcher must
        # then report as a memory snapshot for the page to persist.
        device_id = gateways[0]["buses"][0]["devices"][0]["id"]
        await browser.rpc("Editor", "GetDevice", json.dumps({"deviceId": device_id}))
        for _ in range(100):
            await asyncio.sleep(0.05)
            if any(report[2].get(f"{GATEWAY}_bus_1", {}).get("gear") for report in reports):
                break
        else:
            raise AssertionError(f"watcher never reported the memory snapshot: {reports[-1:] }")
    finally:
        await browser.stop()
        browser.Path = original_root
