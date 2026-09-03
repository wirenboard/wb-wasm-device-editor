# Plan: embed the DALI configuration UI (homeui + wb-mqtt-dali) into the WASM standalone editor

## Goal

The standalone `wb-wasm-device-editor` (single-page, offline-capable, WebSerial) gains a
**DALI** section that is the same UI homeui ships (`src/pages/settings/configs/dali`),
backed by the **real `wb-mqtt-dali` Python daemon** running in the browser under **Pyodide**.

No hardware available → a **virtual WB-DALI gateway + DALI bus simulator** stands in for the
real Modbus gateway, behind the exact same transport seam the real one uses.

## Discovered architecture (facts, verified in-tree)

```
homeui DALI UI  ──DaliProxy (13 Editor/* methods)──►  MQTT-RPC topics
                ──mqttClient (retained topics)─────►  /wb-dali/<busUid>/commissioning
                                                      /wb-dali/<uid>/bus_monitor

wb-mqtt-dali    Gateway.start() registers Editor/* + Bus/* endpoints on MQTTRPCServer
                MQTTRPCServer/MQTTDispatcher sit on ONE aiomqtt.Client  ← the seam
                Gateway.start() requires retained /rpc/v1/wb-mqtt-serial/config/Load
                and calls rpc_call("wb-mqtt-serial","config","Load") to enumerate gateways

WBDALIDriver    TX: publish /rpc/v1/wb-mqtt-serial/port/Load/<cid>
                    {device_id, function:6/16, address, count, format:"HEX", msg}
                RX: subscribes /devices/<dev>/controls/bus_<N>_bulk_send_reply_<0..15>
                    /devices/<dev>/controls/bus_<N>_monitor_sporadic_frame_<1..4>
                    /devices/<dev>/meta/error
```

Everything the daemon needs from the outside world is **MQTT publish/subscribe on one client**.
That is the single integration point.

## Target architecture

```
┌─ Browser tab ────────────────────────────────────────────────────────────┐
│  React app (vite)                                                        │
│   ├── existing Modbus device editor (C++ WASM + WebSerial)               │
│   └── NEW "DALI" page  ← homeui src/pages/settings/configs/dali (as-is)  │
│         DaliStore(whenMqttReady, daliProxy, mqttClient)                  │
│                 │                    │                                    │
│         daliProxy (JS)        mqttClient shim (JS)                        │
│                 └────────┬───────────┘                                    │
│                          ▼                                                │
│                 dali-bridge.ts  (publish/subscribe over a JS↔Py channel)  │
│                          ▼                                                │
│  ┌─ Web Worker: Pyodide ─────────────────────────────────────────────┐   │
│  │  loopback MQTT broker  (aiomqtt.Client-compatible, retained, wildcards)│
│  │      ├── wb.mqtt_dali.Gateway  (UNMODIFIED daemon code)           │   │
│  │      ├── wb-mqtt-serial emulator                                   │   │
│  │      │     • serves /rpc/v1/wb-mqtt-serial/config/Load             │   │
│  │      │     • serves port/Load  → Modbus transport                  │   │
│  │      │     • polls gateway regs → publishes /devices/... controls  │   │
│  │      └── Modbus transport (pluggable)                              │   │
│  │            ├─ SIM:  virtual WB-DALI gateway + DALI bus + ballasts  │   │
│  │            └─ REAL: JS Module.portLoad() → C++ WASM → WebSerial    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

Design rules:
- **Do not fork wb-mqtt-dali.** Vendor it as-is; all adaptation lives in shims
  (`aiomqtt`, `paho.mqtt.matcher`, `wb_common`, `websockets` stubs) and in new modules.
- The simulator is a **Modbus-level** emulation, so every layer above it
  (frame encoding, queue pointers, commissioning binary search, DT parameter reads)
  is the production code path.
- The simulator must be runnable and testable under **plain CPython + pytest**,
  outside the browser. That is where most debugging happens.

## Phases

| Phase | Work | Verification |
|---|---|---|
| 0 | Environment: npm installs, docker+emsdk, build C++ WASM module, dev server up | app loads in chromium |
| 1 | Research: daemon runtime map, gateway Modbus protocol spec, Pyodide bring-up, UI surface | written specs |
| 2a | `wbdali_sim`: virtual WB-DALI gateway + DALI bus + control gear | pytest: commissioning finds N devices |
| 2b | loopback MQTT broker + wb-mqtt-serial emulator + runtime bootstrap | pytest: Editor/GetList returns tree |
| 2c | Pyodide packaging (vendored sources, stubs, worker) | node: import + Editor/GetList |
| 2d | Frontend: DALI page mounted in the wasm app + bridge | chromium screenshot |
| 3 | End-to-end in chromium: scan bus, see devices, edit device params, groups, bus monitor | screenshots + console clean |
| 4 | Real-hardware transport via `Module.portLoad` (best effort, cannot be tested) | code review |

## Non-goals for now
- MQTT virtual-device publishing (`/devices/wb-dali-...`) beyond what the editor needs.
- Lunatone websocket gateway.
- Offline single-file build size optimisation (note it, don't solve it).
