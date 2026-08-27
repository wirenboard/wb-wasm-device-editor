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

    Two luminaires already carry short addresses, as they would after a previous
    commissioning run; two are factory-fresh and only appear after a scan. The
    wall switch is a DALI-2 control device, so a scan exercises the input-device
    half of commissioning as well.
    """
    return {
        "gateways": [
            {
                "id": "wb-mdali_1",
                "slaveId": 1,
                "buses": {
                    "1": {
                        "gear": [
                            {"shortAddress": 0, "randomAddress": 0x1A2B3C, "deviceTypes": [6]},
                            {"shortAddress": 1, "randomAddress": 0x4D5E6F, "deviceTypes": [6]},
                            {"shortAddress": None, "randomAddress": 0x7A8B9C, "deviceTypes": [8]},
                            {"shortAddress": None, "randomAddress": 0xC1D2E3, "deviceTypes": [6]},
                        ],
                        "devices": [
                            {"shortAddress": None, "randomAddress": 0x2B3C4D},
                        ],
                    },
                    "2": {"gear": [], "devices": []},
                    "3": {"gear": [], "devices": []},
                },
            }
        ],
        "frameDelaySeconds": 0.0,
    }


def build_network(scenario: Dict[str, Any]) -> SimulatedModbusNetwork:
    network = SimulatedModbusNetwork(frame_delay_s=float(scenario.get("frameDelaySeconds") or 0.0))
    for gateway in scenario.get("gateways", []):
        buses = {index: SimulatedDaliBus() for index in BUS_NUMBERS}
        for bus_key, wiring in (gateway.get("buses") or {}).items():
            bus = buses[_bus_number(bus_key)]
            for unit in _control_gear(wiring):
                bus.add_gear(_make_gear(unit))
            for unit in _control_devices(wiring):
                bus.add_device(_make_device(unit))
        network.add_module(gateway["id"], buses)
    return network


def _bus_number(bus_key: Any) -> int:
    number = int(bus_key)
    if number not in BUS_NUMBERS:
        raise ValueError(f"a WB-DALI module has buses 1..3, not {number}")
    return number


def _control_gear(wiring: Any) -> list:
    """A bus is either a bare list of control gear, or `{gear, devices}`.

    The bare list is what a scenario written before DALI-2 support looks like,
    and one may still be sitting in a browser's local storage.
    """
    if isinstance(wiring, dict):
        return list(wiring.get("gear") or [])
    return list(wiring or [])


def _control_devices(wiring: Any) -> list:
    return list(wiring.get("devices") or []) if isinstance(wiring, dict) else []


def _make_gear(unit: Dict[str, Any]) -> SimulatedControlGear:
    return SimulatedControlGear(
        shortaddr=unit.get("shortAddress"),
        random_address=unit.get("randomAddress"),
        colour_temperature=unit.get("colourTemperature"),
        groups=set(unit.get("groups") or []),
        devicetypes=list(unit.get("deviceTypes") or []),
    )


def _make_device(unit: Dict[str, Any]) -> SimulatedControlDevice:
    return SimulatedControlDevice(
        shortaddr=unit.get("shortAddress"),
        random_address=unit.get("randomAddress"),
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


def export_scenario(scenario: Dict[str, Any], network: SimulatedModbusNetwork) -> Dict[str, Any]:
    """Read the simulated installation back out, short addresses included.

    Commissioning writes short addresses into the control gear, and the daemon
    records them in its config. Persisting one without the other would make a
    reload look like a bus whose devices had all been swapped: the config would
    claim addressed devices where the simulation had factory-fresh ones.
    """
    exported = {**scenario, "gateways": []}
    for gateway in scenario.get("gateways", []):
        simulated = network.gateways.get(gateway["id"])
        if simulated is None:
            exported["gateways"].append(gateway)
            continue
        exported["gateways"].append(
            {
                **gateway,
                "buses": {
                    str(index): {
                        "gear": [_export_gear(unit) for unit in bus.dali_bus.gear],
                        "devices": [_export_device(unit) for unit in bus.dali_bus.devices],
                    }
                    for index, bus in simulated.buses.items()
                },
            }
        )
    return exported


def _export_gear(unit) -> Dict[str, Any]:
    return {
        "shortAddress": unit.shortaddr,
        "randomAddress": unit.randomaddr.as_integer,
        "deviceTypes": list(unit.devicetypes),
        "colourTemperature": unit.actual_ct,
        "groups": sorted(unit.groups),
    }


def _export_device(unit) -> Dict[str, Any]:
    return {
        "shortAddress": unit.short_address,
        "randomAddress": unit.randomaddr.as_integer,
    }
