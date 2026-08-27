"""Builds a simulated DALI installation from a plain description.

The description comes from JavaScript, so it is JSON-shaped: no classes, no
Python objects. It says which WB-DALI modules exist and what is wired to their
buses, and this module turns that into a `SimulatedModbusNetwork` plus the
wb-mqtt-serial config that makes the daemon discover them.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .sim.control_gear import SimulatedControlDevice, SimulatedControlGear
from .sim.dali_bus import SimulatedDaliBus
from .sim.network import SimulatedModbusNetwork

BUS_NUMBERS = (1, 2, 3)


def default_scenario() -> Dict[str, Any]:
    """One module with a small mixed installation on bus 1.

    Two units already carry short addresses, as they would after a previous
    commissioning run; two are factory-fresh and only appear after a scan. That
    is enough to exercise both halves of the commissioning algorithm.
    """
    return {
        "gateways": [
            {
                "id": "wb-mdali_1",
                "slaveId": 1,
                "buses": {
                    "1": [
                        {"shortAddress": 0, "randomAddress": 0x1A2B3C, "deviceTypes": [6]},
                        {"shortAddress": 1, "randomAddress": 0x4D5E6F, "deviceTypes": [6]},
                        {"shortAddress": None, "randomAddress": 0x7A8B9C, "deviceTypes": [8]},
                        {"shortAddress": None, "randomAddress": 0xC1D2E3, "deviceTypes": [6]},
                    ],
                    "2": [],
                    "3": [],
                },
            }
        ],
        "frameDelaySeconds": 0.0,
    }


def build_network(scenario: Dict[str, Any]) -> SimulatedModbusNetwork:
    network = SimulatedModbusNetwork(frame_delay_s=float(scenario.get("frameDelaySeconds") or 0.0))
    for gateway in scenario.get("gateways", []):
        buses = {index: SimulatedDaliBus() for index in BUS_NUMBERS}
        for bus_key, units in (gateway.get("buses") or {}).items():
            bus = buses[int(bus_key)]
            for unit in units or []:
                bus.add_gear(_make_gear(unit))
            for unit in (gateway.get("devices") or {}).get(bus_key, []):
                bus.add_device(SimulatedControlDevice())
        network.add_module(gateway["id"], buses)
    return network


def _make_gear(unit: Dict[str, Any]) -> SimulatedControlGear:
    return SimulatedControlGear(
        shortaddr=unit.get("shortAddress"),
        random_address=unit.get("randomAddress"),
        groups=set(unit.get("groups") or []),
        devicetypes=list(unit.get("deviceTypes") or []),
    )


def serial_config(scenario: Dict[str, Any]) -> Dict[str, Any]:
    """The wb-mqtt-serial config the daemon reads to find WB-DALI modules.

    `Gateway._update_gateways` drops any gateway that is not listed here as an
    enabled WB-DALI device, so the two descriptions have to agree.
    """
    devices: List[Dict[str, Any]] = [
        {
            "id": gateway["id"],
            "slave_id": gateway.get("slaveId", index + 1),
            "device_type": "WB-DALI",
            "enabled": True,
        }
        for index, gateway in enumerate(scenario.get("gateways", []))
    ]
    return {"ports": [{"path": "/dev/ttyRS485-1", "enabled": True, "devices": devices}]}
