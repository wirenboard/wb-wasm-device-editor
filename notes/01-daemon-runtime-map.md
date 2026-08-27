# wb-mqtt-dali runtime map (for Pyodide / browser hosting)

Source of truth: `/tmp/wb-mqtt-dali` (upstream checkout).
Vendored verbatim copy: `.../wasm/python/vendor/wb/`.
All line refs below are `/tmp/wb-mqtt-dali/<path>:<line>` unless stated otherwise.

---

## 1. Minimal boot

### What `default_service` actually builds

`wb/mqtt_dali/main.py:165-199`:

```
config        = load_config(args.config)                       # main.py:167 -> main.py:106
gtin_db       = DaliDatabase(GTIN_DB_FILEPATH)                 # main.py:176
client        = make_mqtt_client(args.broker_url)              # main.py:178
mqtt_dispatcher = MQTTDispatcher(client)                       # main.py:180
gateway       = Gateway(config, mqtt_dispatcher, args.config, gtin_db)   # main.py:181
# then, per broker session (main.py:140-162):
async with client:
    dispatcher_task = create_task(mqtt_dispatcher.run())       # main.py:148
    gateway_task    = create_task(gateway.start())             # main.py:149
```

Constructor arguments and their provenance:

| arg | where from | note |
|---|---|---|
| `config: dict` | `load_config(args.config)` = JSON at `/etc/wb-mqtt-dali.conf`, validated against `wb-mqtt-dali.schema.json` then `validate_config()` | `main.py:106-121` |
| `mqtt_dispatcher` | `MQTTDispatcher(client)` where client is `aiomqtt.Client` | `mqtt_dispatcher.py:11` |
| `config_path: str` | `args.config`, default `/etc/wb-mqtt-dali.conf` (`main.py:31`) | used *only* by `save_configuration` |
| `gtin_db: DaliDatabase` | `DaliDatabase("/usr/share/wb-mqtt-dali/products.csv")` (`main.py:34,176`) | read eagerly at construction |
| `command_registry` | optional; `build_command_registry()` if `None` (`gateway.py:225-226`) | pure Python, no I/O |

`MQTTDispatcher.client_id` (`mqtt_dispatcher.py:126-128`) reaches into
`client._client._client_id` — the loopback broker's `Client` must expose that
attribute chain (`WBDALIDriver.__init__` uses it, `wbdali.py:486`).

### Ordering constraints in `Gateway.start()` (`gateway.py:257-364`)

1. `remove_topics_by_driver(dispatcher, "wb-mqtt-dali")` — `gateway.py:259`.
   Wrapped in try/except, failures only logged. Internally subscribes to
   `/devices/#`, does the *retain hack* (`wbmqtt.py:263-281`: publish to
   `/wbretainhack/<rand>` qos=2 and wait for the echo, **timeout 120 s**),
   `asyncio.sleep(0.05)`, then unsubscribes and deletes retained topics of
   devices whose `/devices/<d>/meta` has `"driver":"wb-mqtt-dali"`
   (`wbmqtt.py:284-329`). **The loopback broker must echo a published message
   back to its own subscriber**, otherwise boot stalls 120 s here (it does not
   fail, just waits).
2. `await wait_for_rpc_endpoint("wb-mqtt-serial", "config", "Load", dispatcher)` —
   `gateway.py:263-272`. Default `timeout=5.0` (`mqtt_rpc_client.py:18`). It
   subscribes to `/rpc/v1/wb-mqtt-serial/config/Load` and resolves on the
   **first message on that topic**. On timeout it raises
   `RuntimeError("Required RPC endpoint wb-mqtt-serial/config/Load is not
   available")` and the whole gateway boot fails.
   => the fake wb-mqtt-serial must have published a **retained** `"1"` to
   `/rpc/v1/wb-mqtt-serial/config/Load` *before* `Gateway.start()` is awaited,
   and the broker must deliver retained messages on SUBSCRIBE.
3. `asyncio.gather(gw.start() ...)` for every `WbDaliGateway` — `gateway.py:274`.
4. `await self._update_gateways()` — `gateway.py:278`. See warning below.
5. re-raise any gateway start exception — `gateway.py:279-281`.
6. `_publish_idle_commissioning_state_for_all_buses()` — `gateway.py:282`,
   retained publish of `CommissioningState().to_dict()` to
   `/wb-dali/<busUid>/commissioning`.
7. `rpc_server.start()` (`gateway.py:283`) subscribes to
   `/rpc/v1/wb-mqtt-dali/+/+/+`, then 15 × `add_endpoint(...)`
   (`gateway.py:284-364`), each of which publishes retained `"1"` to
   `/rpc/v1/wb-mqtt-dali/<Service>/<Method>`.

**`_update_gateways()` is a trap** (`gateway.py:697-733`): it calls
`rpc_call("wb-mqtt-serial", "config", "Load", {}, dispatcher)` (timeout 2.0 s,
`mqtt_rpc_client.py:50`) and then *reconciles the gateway list against the serial
config*: any `WbDaliGateway` whose `uid` is not present as an enabled
`WB-DALI`/`WB-MDALI` device is **stopped and dropped**, and unknown serial
devices get a brand new gateway with 3 empty buses. It then calls
`_save_configuration()` — i.e. it rewrites `/etc/wb-mqtt-dali.conf`.

Consequences for the browser build:
* If the fake answers `{"result": {"config": {"ports": []}}}`, **every configured
  gateway is deleted** and `Editor/GetList` returns `[]`.
* If the RPC times out / raises, `_update_gateways` logs at DEBUG and `return`s
  early (`gateway.py:701-703`) — the config-defined gateways survive untouched
  and no config write happens. This is the *safe* failure mode.
* The same `_update_gateways()` runs on **every** `Editor/GetList` call
  (`gateway.py:402`).

So the fake serial must publish a `config/Load` reply containing the gateway
`device_id`s used in the DALI config, e.g.
`{"config": {"ports": [{"enabled": true, "devices": [{"enabled": true,
"id": "wb-dali_1", "device_type": "WB-DALI", "slave_id": 1}]}]}}`.

### Minimal `boot()` sketch

```python
async def boot(config_path="/etc/wb-mqtt-dali.conf"):
    from wb.mqtt_dali.main import load_config          # main.py:106
    from wb.mqtt_dali.gateway import Gateway           # gateway.py:215
    from wb.mqtt_dali.gtin_db import DaliDatabase      # gtin_db.py:5
    from wb.mqtt_dali.mqtt_dispatcher import MQTTDispatcher

    config   = load_config(config_path)                # needs conf + schema on the FS
    gtin_db  = DaliDatabase("/usr/share/wb-mqtt-dali/products.csv")
    client   = BrowserClient()                         # runtime/wbdali_browser/broker.py
    disp     = MQTTDispatcher(client)
    gw       = Gateway(config, disp, config_path, gtin_db)

    async with client:
        disp_task = asyncio.create_task(disp.run())    # MUST be running first:
                                                       # every subscribe/await below
                                                       # depends on it dispatching
        await seed_fake_wb_mqtt_serial(client)         # retained "1" on
                                                       # /rpc/v1/wb-mqtt-serial/config/Load
                                                       # + a responder for the actual call
        await gw.start()                               # gateway.py:257
        return gw, disp, disp_task
```

`load_config` may be bypassed entirely (parse the JSON yourself and hand the dict
to `Gateway`) — nothing else in the daemon reads the file back.

Notes:
* `main.py` also installs SIGINT/SIGTERM handlers (`wait_for_cancel`,
  `main.py:85-95`) — `loop.add_signal_handler` is **not available in Pyodide**;
  do not reuse `_serve_connection`/`default_service`, construct `Gateway`
  directly.
* `logging.basicConfig` + journal handler (`main.py:63-82,498`) — skip; imports
  `systemd.journal` only when `$JOURNAL_STREAM` matches stderr, so harmless, but
  no reason to call `main()`.
* `Gateway.start()` never returns a running loop of its own; the only long-lived
  tasks are `MQTTDispatcher.run()` and, per bus, `ApplicationController._polling_loop`.

---

## 2. Config

### Schema

`/tmp/wb-mqtt-dali/wb-mqtt-dali.schema.json` (installed to
`/usr/share/wb-mqtt-confed/schemas/wb-mqtt-dali.schema.json`, `debian/wb-mqtt-dali.install`).
draft-04. Top level: `debug: boolean`, `gateways: array<gateway>`.

* `gateway` — required `device_id: string`, `buses: array<bus>` (**`maxItems: 3`**);
  optional `websocket_enabled: boolean`, `websocket_port: integer 1..65535`.
* `bus` — required `devices: array<device>`; optional `bus_monitor_enabled`,
  `bus_monitor_syslog_enabled` (both boolean, default false).
* `device` — required `short: integer 0..63`, `random: integer`; optional
  `dali2: boolean` (default false), `mqtt_id: string`, `name: string`.

`load_config` (`main.py:106-121`) validates against that schema, then calls
`validate_config` (`config_validator.py:7-28`) which only checks for duplicate
effective `mqtt_id` (explicit, or default `<device_id>_bus_<N>_[dali2_]<short>`)
**across all gateways/buses**, raising `ValueError` on a clash.

### Minimal valid config, one WB-DALI gateway, three buses, no devices

```json
{
    "debug": false,
    "gateways": [
        {
            "device_id": "wb-dali_1",
            "buses": [
                { "devices": [] },
                { "devices": [] },
                { "devices": [] }
            ]
        }
    ]
}
```

Verified: boots, `Editor/GetList` answers (see §3). `debug`, `websocket_*`,
`bus_monitor_*` may all be omitted.

### Two pre-seeded devices on bus 1

```json
{
    "debug": false,
    "gateways": [
        {
            "device_id": "wb-dali_1",
            "websocket_enabled": false,
            "websocket_port": 8080,
            "buses": [
                {
                    "bus_monitor_enabled": false,
                    "bus_monitor_syslog_enabled": false,
                    "devices": [
                        { "short": 0, "random": 12345678 },
                        { "short": 1, "random": 87654321, "dali2": true, "name": "Hall button" }
                    ]
                },
                { "devices": [] },
                { "devices": [] }
            ]
        }
    ]
}
```

`device_id` must match a `WB-DALI`/`WB-MDALI` device the fake wb-mqtt-serial
reports, or `_update_gateways` will delete the gateway (§1).

### `save_configuration` (`gateway.py:721-759`)

```python
real_config_path = os.path.realpath(config_path)     # :722
config_dir       = os.path.dirname(real_config_path) # :723
temp_fd, temp_path = tempfile.mkstemp(prefix="wb-mqtt-dali",
                                      suffix=".cfg.tmp", dir=config_dir)  # :725-729
...json.dump(config, temp_f, indent=4)               # :755
os.replace(temp_path, config_path)                   # :756
finally: if os.path.exists(temp_path): os.unlink(temp_path)  # :757-759
```

* **tempfile + `os.replace` in the same directory** — both work on Pyodide MEMFS
  (`tempfile.mkstemp` uses `os.open(O_CREAT|O_EXCL)`, `os.replace` maps to MEMFS
  rename). The *directory of the config must exist and be writable*; if the config
  lives at `/etc/wb-mqtt-dali.conf`, `/etc` must be a writable MEMFS dir.
* Written content: **only** `gateways` (device_id, websocket_enabled,
  websocket_port, buses[{devices, bus_monitor_enabled, bus_monitor_syslog_enabled}]),
  plus `"debug": true` **only when debug was truthy** (`gateway.py:753-754`).
  Every other key in the original file (comments, unknown keys, `"debug": false`)
  is **dropped**.
* Per-device keys written (`get_dict_for_device_config`, `gateway.py:707-718`):
  always `short`, `random`; `dali2: true` only for `Dali2Device`; `mqtt_id`
  only if `has_custom_mqtt_id`; `name` only if `has_custom_name`.

When it runs:
* `Gateway.start()` → `_update_gateways()` → `_save_configuration()`
  (`gateway.py:733`) — **on every boot**, and only if the `wb-mqtt-serial`
  `config/Load` RPC succeeded.
* every `Editor/GetList` (`gateway.py:402` → same path).
* `Editor/SetBus` (`gateway.py:511`), `Editor/SetGateway` (`gateway.py:622`),
  `Editor/ResetDevice` (`gateway.py:559`), and on commissioning
  `COMPLETED` (`gateway.py:468-476`).
* `Editor/SetDevice` and `Editor/SetGroup` do **not** write the file.

Confirmed empirically: booting with the minimal config above rewrote it in
place, dropping `"debug": false` and adding `websocket_*` / `bus_monitor_*`.

---

## 3. Editor RPC handlers

Registered in `Gateway.start()` (`gateway.py:284-364`). Topic
`/rpc/v1/wb-mqtt-dali/<Service>/<Method>/<clientId>`, reply on the same topic
+ `/reply`, MQTT-RPC 1.0 envelope (`mqtt_rpc_server.py:19-20,76-118`).
Request `{"id":…, "params":{…}}`; reply `{"id":…, "result":…, "error":null}` or
`{"id":…, "error":{"code":-32000,"message":"Server error","data":"…"}}`.

| RPC | handler | params | result | bus I/O | writes config |
|---|---|---|---|---|---|
| `Editor/GetList` | `gateway.py:401` | none | list of gateways (below) | **no DALI I/O**, but does the wb-mqtt-serial `config/Load` RPC | **yes** (via `_update_gateways`) |
| `Editor/GetGateway` | `gateway.py:587` | `gatewayId` | `{config:{websocket_enabled,websocket_port}, schema:{}}` | no | no |
| `Editor/SetGateway` | `gateway.py:600` | `gatewayId`, `config` | `{websocket_enabled,websocket_port}` | no (starts/stops websocket task) | **yes** (`:622`) |
| `Editor/GetBus` | `gateway.py:482` | `busId` | `{config:{bus_monitor_enabled,bus_monitor_syslog_enabled}, schema}` | **no** — `load_bus_info` is pure in-memory | no |
| `Editor/SetBus` | `gateway.py:500` | `busId`, `config` | `{bus_monitor_enabled,bus_monitor_syslog_enabled}` | only if `config` carries keys other than the two monitor flags → `apply_bus_parameters` → broadcast writes on the bus | **yes** (`:511`) |
| `Editor/GetDevice` | `gateway.py:415` | `deviceId`, `forceReload?` | `{config: device.params, schema: device.schema}` | **yes** — `initialize()` + read every settings param | no |
| `Editor/SetDevice` | `gateway.py:427` | `deviceId`, `config` | `device.params` | **yes** — writes every changed param | no |
| `Editor/GetGroup` | `gateway.py:517` | `groupId` (`<busUid>_g<0..15>`) | merged JSON schema dict | **no** — in-memory only | no |
| `Editor/SetGroup` | `gateway.py:526` | `groupId`, `config` | `{}` | **yes** — group-addressed writes | no |
| `Editor/ScanBus` | `gateway.py:445` | `busId` | `{status:"started"\|"already_running", progressTopic}` | queues commissioning (returns immediately) | on COMPLETED (`:468-476`) |
| `Editor/StopScanBus` | `gateway.py:453` | `busId` | `{status:"stopped"\|"not_running"}` | no | no |
| `Editor/IdentifyDevice` | `gateway.py:537` | `deviceId` | `{}` | **yes** (DALI-2 `Identify`, DALI DAPC blinks; `dali_device.py:375,377` sleep 0.5 s twice) | no |
| `Editor/ResetDeviceSettings` | `gateway.py:545` | `deviceId` | `{}` | **yes** — `Reset` + 0.35 s settle + re-init | no |
| `Editor/ResetDevice` | `gateway.py:553` | `deviceId` | `{}` | **yes** — `Reset` + 0.35 s + clear short address | **yes** (`:559`) |
| `Bus/SendCommand` | `gateway.py:562` | `busId`, `commands: [str]` | list of `{status, response?, error?}` | **yes** | no |
| `Bus/ListCommands` | `gateway.py:578` | none | command catalog | no | no |

Note: `_get_bus_and_group_index_by_id` splits on the literal `"_g"`
(`gateway.py:643`), so the group id the daemon accepts is
`<busUid>_g<index>` — **not** the `..._group_00` form the docs show
(`docs/editor_rpc.md`), and not the group virtual device's `mqtt_id`.

### `Editor/GetList` for the minimal config — captured from a real boot

```json
[
  {
    "id": "wb-dali_1",
    "name": "wb-dali_1",
    "buses": [
      {
        "id": "wb-dali_1_bus_1",
        "name": "Bus 1",
        "devices": [],
        "commissioning": {
          "status": "idle",
          "progress": 0,
          "error": null,
          "devices": [],
          "finished_at": null,
          "device_count": 0
        },
        "bus_monitor_enabled": false,
        "bus_monitor_syslog_enabled": false
      },
      { "id": "wb-dali_1_bus_2", "name": "Bus 2", "devices": [], "commissioning": { … }, "bus_monitor_enabled": false, "bus_monitor_syslog_enabled": false },
      { "id": "wb-dali_1_bus_3", "name": "Bus 3", "devices": [], "commissioning": { … }, "bus_monitor_enabled": false, "bus_monitor_syslog_enabled": false }
    ]
  }
]
```

Shape from `bus_to_json` (`gateway.py:195-212`) and `get_list_rpc_handler`
(`gateway.py:401-413`). The `bus_monitor_*` keys are **not** in
`docs/editor_rpc.md` — the doc is stale.

With the two pre-seeded devices (silent bus), bus 1 becomes:

```json
"devices": [
  { "id": "26ded80b-93c7-4f97-b802-a40f105a5b47", "name": "DALI 0",      "groups": [] },
  { "id": "900579eb-4469-465e-8f01-cfc1d8e5f49b", "name": "Hall button", "groups": [] }
]
```

**The device `id` is a fresh `uuid4()`** minted in `DaliDeviceBase.__init__`
(`common_dali_device.py:669`), *not* the mqtt_id — `docs/editor_rpc.md` claims
`wb-mdali_1_bus_1_0` and is wrong. The uid changes on every restart, so the UI
must always take device ids from a fresh `GetList`. `name` falls back to
`"DALI <short>"` / `"DALI-2 <short>"` (`common_dali_device.py:735-737`).
`groups` is empty until the device is initialized on the bus.

### `Editor/GetBus`, `Editor/GetGateway` — captured

```json
// GetBus {busId:"wb-dali_1_bus_1"}
{ "config": { "bus_monitor_enabled": false, "bus_monitor_syslog_enabled": false },
  "schema": {} }

// GetGateway {gatewayId:"wb-dali_1"}
{ "config": { "websocket_enabled": false, "websocket_port": 8080 },
  "schema": {} }
```

`GetGateway`'s schema is a **hardcoded empty dict** (`gateway.py:597`) — the UI
must own the gateway form.
`GetBus`'s schema comes from `ApplicationController.load_bus_info`
(`application_controller.py:723-730`): for every **initialized** `DaliDevice` on
the bus it merges `handler.get_schema(group_and_broadcast=True)` for each
`get_group_parameter_handlers()` entry via `utils.merge_json_schemas`. With no
initialized gear it is `{}`; on error the handler substitutes
`{"type":"object","properties":{}}` (`gateway.py:488-491`). `Editor/GetGroup`
uses the same merge, restricted to devices in that group
(`application_controller.py:704-711`).

### `Editor/GetDevice`

`gateway.py:415-425` → `ApplicationController.load_device_info`
(`application_controller.py:663-671`) enqueues a `LOAD_INFO` task and **awaits
its future**, so the reply waits for the polling loop to run
`device.load_info(driver, force_reload)` (`common_dali_device.py:758-796`):

1. short-circuits if `self.params` is already populated and not `force_reload`;
2. `await self.initialize(driver)` — the full DT/feature discovery on the bus;
3. `params = {short_address, random_address (hex string), name, mqtt_id}` then
   `param_handler.read(...)` for every handler, gathered, **any exception
   aborts the whole call** with `RuntimeError('Error reading "<name>": …')`;
4. `schema = deepcopy(self._common_schema)` then
   `merge_json_schemas(schema, handler.get_schema(False))` for each handler.

`_common_schema` is `/usr/share/wb-mqtt-dali/schemas/common_device.schema.json`
(`common_dali_device.py:696-699`) — a draft-07 object with
`name`, `mqtt_id`, `types`, `brand_name`, `product_name`, `gtin`,
`identification_number`, `firmware_version`, `hardware_version`, `oem_gtin`,
`oem_identification_number`, `short_address`, `random_address`, plus
`required: [short_address, mqtt_id, name]` and a `translations.ru` block. The
per-DT handlers (`settings.py:SettingsParamBase.get_schema`, and the
`dali_type*_parameters.py` / `dali_common_parameters.py` families) then add
their properties on top.

**Against a silent bus `GetDevice` cannot succeed.** Measured on the loopback
broker with no gateway answering: reply after **13.6 s** with

```json
{"id": 1, "error": {"code": -32000, "message": "Server error",
 "data": "No response to QueryDeviceType(<address (control gear) 0>) after 3 attempts; last error: No response from gateway"}}
```

(3 attempts × `WAIT_DALI_RESPONSE_TIMEOUT_S = 1.5 s`, `wbdali.py:74-75`, plus the
queued retries of the concurrent background init).

---

## 4. `ApplicationController` lifecycle

`ApplicationController.start()` (`application_controller.py:504-547`), in order:

1. state `UNINITIALIZED` → `INITIALIZING` (`:505-508`).
2. `await self._dev.initialize()` (`:511`) = `WBDALIDriver.initialize`
   (`wbdali.py:537-561`):
   * spawns the `_queue_sender` task (`wbdali.py:540`) — **long-lived**;
   * `_reset_queue_in_gateway()` (`wbdali.py:542,627-640`): a single
     `send_modbus_rpc_no_response` — it **publishes and does not wait for a
     reply** (`wbdali.py:596-625`). So a silent/absent gateway costs nothing here;
   * 16 subscribes to `/devices/<gwId>/controls/bus_<N>_bulk_send_reply_<0..15>`,
     4 subscribes to `…/bus_<N>_monitor_sporadic_frame_<1..4>`, 1 subscribe to
     `/devices/<gwId>/meta/error`.
   Only a raised exception here fails `start()` (`:512-515`).
3. `self._device_publisher.initialize()` (`:518`) — no-op with no devices.
4. `_publish_virtual_device(self._broadcast_device)` (`:519`) — **publishes the
   bus broadcast virtual device to MQTT unconditionally**, even on an empty bus
   (verified: `/devices/<gwId>_bus_<N>_broadcast/meta` + ~15 controls per bus).
5. For each configured device: register in `_devices_by_mqtt_id`, set logger,
   and `self._init_scheduler.schedule(mqtt_id, now)` (`:522-525`) — **queued
   only**; no bus traffic yet.
6. state → `READY` (`:544-545`).
7. `self._polling_task = asyncio.create_task(self._polling_loop())` (`:547`).

**So `start()` performs zero DALI transactions.** With zero devices *and* with
pre-seeded devices it returns in milliseconds. Measured: `Gateway.start()`
(3 buses, fake serial answering) took **0.062 s** empty and **0.067 s** with two
pre-seeded devices on a fully silent bus.

### Background tasks and their periods

| task | spawned at | period / cadence |
|---|---|---|
| `MQTTDispatcher.run()` | caller (`main.py:148`) | message-driven |
| `WBDALIDriver._queue_sender` | `wbdali.py:540`, 1 per bus | drains the send queue; batches wait `WAIT_COMMANDS_FOR_BATCH_TIMEOUT_S = 0.01 s` (`wbdali.py:76`); per-command response timeout `WAIT_DALI_RESPONSE_TIMEOUT_S = 1.5 s` (`wbdali.py:74-75`) |
| `ApplicationController._polling_loop` | `application_controller.py:547`, 1 per bus | queue-driven with a timeout; `_poll_step` returns 0.001 s while there is work, otherwise `min(1.0, time_until_next_poll)` (`:1374-1386`) — **so an idle bus wakes at most once a second** |
| device init retries | inside `_poll_step` (`:1348-1368`) | `DeviceInitScheduler`: first attempt immediately, then 5 s × 2ⁿ capped at 60 s (`device_init_scheduler.py:4-6`) |
| control polling | `PollScheduler.poll` (`:296-322`) | only over **initialized** gear, ≤3 commands per tick, each control's own interval (periodic params 120 s per README) |
| background settings fetch | `SettingsFetchScheduler.fetch_step` (`:1384`) | one param per idle tick, only for initialized devices |
| `run_websocket` (Lunatone) | `gateway.py:132-136` | only when `websocket_enabled` |
| `OneShotTasks` | `asyncio_utils` | per RPC request / per on-topic write |

### Silent-bus behaviour with pre-seeded devices

The polling loop's first `_poll_step` calls `_do_init_device` for each configured
device (`:1348-1352`) → `try_initialize_device` (`:356-383`) →
`device.initialize(driver)`. On a silent bus this fails after
3 × 1.5 s per query; the failure is **caught**, logged as
`"Failed to initialize device X, retrying in 5s: …"`, the device is published to
MQTT in *error* state (`:381-382`, every readable common control gets
`ControlError.READ`), and it is rescheduled with exponential backoff. Nothing
propagates upward.

**Nothing that `Editor/GetList` needs can fail on a silent bus.** `GetList`
touches only Python objects plus the wb-mqtt-serial RPC; measured **3 ms** with
two un-initializable devices present. `GetBus`, `GetGateway`, `StopScanBus`,
`Bus/ListCommands` are equally safe. Fire-and-forget on a silent bus: device
init, control polling, settings fetch, group/broadcast virtual-device refresh,
bus monitor. Requires a live bus: `GetDevice`, `SetDevice`, `SetGroup`,
`IdentifyDevice`, `ResetDevice*`, `Bus/SendCommand`, `ScanBus`.

Practical consequence: **a bus with no responding gateway still lets the UI
load** — the device tree, bus and gateway forms all render; only per-device
detail pages error out (after ~13 s) or, better, should be gated by the fake
gateway answering.

`ApplicationController.stop()` (`:549-597`) cancels the commissioning child,
sets `_stop_requested`, cancels the polling task with `wait_for(..., 2.0)`,
cancels every queued task's future, cleans the publisher and deinitializes the
driver.

---

## 5. Commissioning (`Editor/ScanBus`)

### Task structure

```
Editor/ScanBus  gateway.py:445-451
  -> ApplicationController.start_commissioning(on_state_changed=cb)   :603-616
       state must be READY; if already running -> "already_running"
       mark_queued() (status="queued", progress=3)  + publish
       put ApplicationControllerTask(COMMISSIONING) on _tasks_queue
     RPC replies IMMEDIATELY: {"status":"started",
                               "progressTopic":"/wb-dali/<busUid>/commissioning"}
  -> polling loop picks the task  :1457
       _run_commissioning_in_child_task()  :1503-1512
         child = create_task(_commissioning_task())   (cancellable by StopScanBus)
         _commissioning_task()  :964-1000
           asyncio.sleep(1)                                <-- fixed 1 s
           StartQuiescentMode(DeviceBroadcast)             (send_with_retry)
           Commissioning(driver, [d.address for d in dali_devices], False, cb)
             .smart_extend()                               <-- DALI phase
           mark_dali2()
           Commissioning(driver, [d.address for d in dali2_devices], True, cb)
             .smart_extend()                               <-- DALI-2 phase
           _read_devices_info(res_dali, res_dali2)          :1002-1026
           finally: StopQuiescentMode(DeviceBroadcast)
           mark_completed(...) / mark_failed(...) / mark_cancelled(...)
```

`Editor/StopScanBus` → `cancel_commissioning` (`:618-661`): cancels the child
task if running, or drops the queued task (`_remove_queued_commissioning_task`,
`:641-661`).

### Who publishes the progress topic

The `ApplicationController` never touches MQTT for this. It calls
`_publish_commissioning_state()` (`:834-845`), which invokes the callback the
`Gateway` handed in. That callback is `Gateway._make_commissioning_state_cb`
(`gateway.py:458-480`): it returns a coroutine that

```python
await self._mqtt_dispatcher.client.publish(
    "/wb-dali/<busUid>/commissioning", json.dumps(state.to_dict()), qos=1, retain=True)
if state.status == CommissioningStatus.COMPLETED:
    await self._save_configuration()
```

and is scheduled through `OneShotTasks`, so publishing is asynchronous w.r.t.
the scan. Topic helper: `commissioning_topic` (`gateway.py:36-38`).
The retained idle payload is written for every bus at boot
(`gateway.py:282,380-390`) and **cleared** (empty retained publish) in
`Gateway.stop()` (`gateway.py:392-399`).

Payload: `CommissioningState.to_dict()` (`application_controller.py:116-130`) —
`status, progress, error, devices[{id,name,groups}], finished_at, device_count`.
`status` is prefixed `dali2_` during the DALI-2 phase for the two search stages
(`:118-122`). Progress bands: queued 3, DALI search 5..50 (`:154`),
DALI-2 search 50..80 (`:152`), read_device_info 81 (`:182`) then 81..99
(`:186`), completed 100 (`:160`).

### Every wall-clock delay

| where | delay | when |
|---|---|---|
| `application_controller.py:968` | `asyncio.sleep(1)` | once, before every scan |
| `wbdali_utils.py:39` `FLASH_WRITE_TIME_S = 0.3` | `commissioning.py:241` | after each `ProgramShortAddress`, once per newly addressed device |
| `commissioning.py:284` | `asyncio.sleep(0.1)` | after each `Terminate+Initialise+Randomise` in `_randomise_by_short` |
| `commissioning.py:483` | `asyncio.sleep(0.1)` | once, if any device was randomised in the short-address poll phase |
| `wbdali.py:74-75` | `WAIT_DALI_RESPONSE_TIMEOUT_S = 1.5` | per in-flight command with no gateway reply |
| `wbdali.py:76` | `WAIT_COMMANDS_FOR_BATCH_TIMEOUT_S = 0.01` | batch accumulation in `_queue_sender` |
| `wbdali_utils.py:36` | `MAX_COMMAND_RETRIES = 3` | `send_with_retry`/`query_response*` retry **only on transmission error** (`wbdali_utils.py:424-432`) — device silence is a valid answer and is not retried |
| `application_controller.py:62` | `RESET_SETTLE_TIME_S = 0.35` | `ResetDevice`/`ResetDeviceSettings`, not commissioning |
| `settle_clock.py:11-36` | fade table 0..90.5 s, `_SETTLE_MARGIN_S = 0.3`, `_STEP_WINDOW_S = 0.2`, `_DEFAULT_FADE_DELAY_S = 6.0` | event-sync confirming polls, not commissioning |
| `commissioning.py:608` | max **3** binary-search passes | per phase |
| `commissioning.py:577-581` | abort if the same random address is found 3× | per phase |

### DALI transaction count for one `smart_extend` phase

From `commissioning.py:427-655`:

| step | frames |
|---|---|
| `_get_present_short_addresses` (`:657-690`) | **64** (QueryControlGearPresent A0..A63 / QueryDeviceStatus for DALI-2), all issued as one `asyncio.gather` |
| `get_random_address` per present short (`:441-443`, `:772-787`) | **3 × P** |
| randomise conflicting / unset randoms (`:478-480`) | 3 per conflicting short, + 0.1 s + 3 more to re-read |
| `Terminate` + `Initialise(MASK)` (`:500-501`) | **2** |
| withdraw pass over known randoms (`:531-543`) | ≤3 SEARCHADDR + QueryShortAddress + Withdraw ≈ **5 × K** |
| binary search (`:556-599`, `:114-144`) | **≈ 74 per newly found device + 4** |
| `ProgramShortAddress` + `VerifyShortAddress` per newly addressed device (`:240-242`) | **2 + 0.3 s** |
| final `Terminate` (`:620`) | **1** |

The 74/device figure is measured, not guessed: simulating
`BinarySearchAddressFinder.find_next_device` + `_set_search_addr` (which only
re-sends the SEARCHADDR bytes that changed) over random 24-bit addresses gives
`4 + 74.6·N` frames — 4.0 for N=0, 59.6 for N=1, 594 for N=8, 1188 for N=16,
4782 for N=64.

**Worked estimates at 10 ms per transaction, one phase:**

* **N=16 devices already correctly addressed and known** (rescan, nothing new):
  64 + 48 + 2 + 80 + 4 + 1 ≈ **199 frames ≈ 2.0 s**.
* **N=16 factory-fresh devices, no short addresses** (worst realistic case):
  64 + 2 + 1188 + 32 + 1 ≈ **1287 frames ≈ 12.9 s**, plus 16 × 0.3 s flash
  waits ≈ 4.8 s → **≈ 17.7 s**.
* **N=64 factory-fresh**: 64 + 2 + 4782 + 128 + 1 ≈ **4977 frames ≈ 49.8 s**,
  plus 64 × 0.3 s ≈ 19.2 s → **≈ 69 s**.

`_commissioning_task` runs **both** phases, so double the fixed 64-frame poll
and add the 1 s pre-sleep and the two quiescent-mode frames. Then
`_read_devices_info` initializes every new/changed device (a full DT discovery
each, tens of frames per device). A realistic full scan of a 16-device bus with
fresh devices lands around **40-60 s** of wall clock; a rescan of a stable bus
around **5-8 s**.

For the browser build: the fake gateway must answer within
`WAIT_DALI_RESPONSE_TIMEOUT_S`; if it just stays silent, `send_with_retry`
returns a transmission-error response 3× per command and the scan takes
`3 × 1.5 s` per command — a 64-frame poll alone becomes ~4.8 s per batch of 16.
