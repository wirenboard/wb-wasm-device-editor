# WB-DALI gateway: Modbus protocol as seen by `wb-mqtt-dali`

Reverse-engineered from `/tmp/wb-mqtt-dali/wb/mqtt_dali/wbdali.py` (authoritative),
its tests, and the wb-mqtt-serial WB-DALI template
(`.../wasm/assets/templates/stable/config-wb-dali.json`,
`.../submodule/wb-mqtt-serial/templates/config-wb-dali.json.jinja`).
All numbers below were verified by running the real code.

Two independent channels connect the driver to the gateway:

* **write side** — MQTT-RPC to wb-mqtt-serial, topic
  `/rpc/v1/wb-mqtt-serial/port/Load/<rpc_client_id>`, fire-and-forget
  (`send_modbus_rpc_no_response`, wbdali.py:596-625; the driver never subscribes to
  a reply topic, so the emulator does **not** have to answer the RPC).
* **read side** — wb-mqtt-serial polls the gateway and publishes each configured
  channel on `/devices/<device_name>/controls/<control_id>`; the driver only
  subscribes (wbdali.py:544-559).

---

## 1. Register map

Per-bus arithmetic (`WBDALIConfig`, wbdali.py:121-132):

```
queue_start_modbus_address        = 1400
queue_bulk_send_pointer_modbus_address = 1432
queue_modbus_bus_offset           = 1000
queue_size                        = 16
bus                               in {1,2,3}          # wbdali.py:466
bus_off = (bus - 1) * 1000
```

| what | reg type | address | count | format | driver access |
|---|---|---|---|---|---|
| bulk send queue (16 slots × 32 bit) | holding | `1400 + bus_off + 2*i`, i=0..15 | 32 regs (1400..1431) | 2 regs/slot, **low word first** | write only, fc 16 |
| bulk send pointer | holding | `1432 + bus_off` | 1 | u16 | write only, fc 6 (reset to 0) |
| bulk send reply *i* | **input** | `1500 + bus_off + i`, i=0..15 | 1 | u16 | read (published by wb-mqtt-serial) |
| bus monitor sporadic frame *r* | **input** | `1900 + bus_off + 4*(r-1)`, r=1..4 | 4 | u64, `word_order: little_endian` | read |

Template evidence (`config-wb-dali.json.jinja:183-215`):

```jinja
"id": "bus_{{ ch + 1 }}_bulk_send_pointer",      "reg_type": "holding", "address": {{ 1432 + (ch*1000) }}, "format": "u16",  "sporadic": true, "hidden": true
"id": "bus_{{ ch + 1 }}_monitor_sporadic_frame_{{r+1}}", "reg_type": "input", "address": {{ 1900 + (ch*1000) + (4*r) }}, "format": "u64", "word_order": "little_endian", "sporadic": true, "hidden": true
"id": "bus_{{ ch + 1 }}_bulk_send_reply_{{ ptr }}",      "reg_type": "input", "address": {{ 1500 + (ch*1000) + ptr }},   "format": "u16", "sporadic": true, "hidden": true
```

So for bus 1 / 2 / 3: queue 1400/2400/3400, pointer 1432/2432/3432, replies
1500-1515 / 2500-2515 / 3500-3515, monitor 1900,1904,1908,1912 / 2900… / 3900….
**The queue buffer itself (1400..1431) is *not* a template channel** — it is
write-only, reached exclusively through `port/Load`.

Other WB-DALI channels the driver does not use but the emulator may want for
realism (same template): `bus_N_state` discrete `1000+ch`, `bus_N_overheat`
discrete `1010+ch`, `bus_N_powered` discrete `1020+ch`,
`bus_N_power_supply_status` discrete `1030+ch`, `bus_N_power_supply` coil
`1030+ch` (parameter), `bus_N_temperature` input s16 `4020+ch`, plus the usual WB
housekeeping (`serial` input u32 @270, `fw_version` string @250, `uptime` u32
@104, `supply_voltage` @121, `mcu_temperature` s16 @124…).
Device-level template settings: `max_read_registers: 0`,
`response_timeout_ms: 1`, `enable_wb_continuous_read: true`.

Note `"sporadic": true` on every DALI channel: on real hardware wb-mqtt-serial
gets them through WB fast-Modbus events rather than polling, and (see
`submodule/wb-mqtt-serial/test/modbus_test.cpp:1216`) **a sporadic register is
republished on every read even when the value has not changed** — that is what
lets two identical consecutive replies (e.g. `0x0200` twice) both reach the
driver. An emulator that publishes on every poll tick reproduces this.

---

## 2. Send path

`WBDALIDriver._queue_sender` (wbdali.py:1004-1064) batches, `_send_to_gateway`
(wbdali.py:1066-1118) writes.

### Batching rules

* Every `send()` / `send_commands()` pushes `SendQueueItem`s into an
  `asyncio.Queue(maxsize=16)` (wbdali.py:474, 1149). `send_commands` holds
  `_send_queue_lock` while enqueuing so a batch is never interleaved.
* The sender pops items with `asyncio.wait_for(..., timeout)` where `timeout`
  is `None` for the first item of a batch and `WAIT_COMMANDS_FOR_BATCH_TIMEOUT_S
  = 0.01` afterwards (wbdali.py:1024, 1035). **10 ms of quiet ⇒ flush.**
* Each accepted item takes the slot `_next_queue_index`, then
  `_next_queue_index += 1`. When it reaches `queue_size` (16) the batch is
  flushed immediately and `_batch_start_index = _next_queue_index = 0`
  (wbdali.py:1046-1052). **A batch therefore never straddles the wrap** —
  verified: 20 identical `Off(broadcast)` commands produced exactly two writes,
  `addr=1400 count=32` (slots 0..15) then `addr=1400 count=8` (slots 0..3).
* Back-pressure (wbdali.py:1010-1021): before consuming a new item, if
  `_waiting_for_responses[_next_queue_index]` still has an unresolved future
  (i.e. the slot's previous occupant has not been answered), the current batch
  is flushed and the sender **awaits that future** before reusing the slot.
* `_send_to_gateway` does nothing when the batch is empty (wbdali.py:1067).
* If `cmd.devicetype != 0`, an `EnableDeviceType(dt)` frame is inserted
  immediately before it and occupies its own queue slot (wbdali.py:1136-1140);
  the extra response is filtered out again at wbdali.py:1155-1164.

### The RPC envelope

`send_modbus_rpc_no_response` (wbdali.py:596-625) publishes to
`/rpc/v1/wb-mqtt-serial/port/Load/<rpc_client_id>` where `rpc_client_id =
"<mqtt client_id with '/'→'_'>-<8 random alnum>"` (wbdali.py:485-486):

```json
{"params": {"device_id": "wb-dali_1", "function": 16, "address": 1400,
            "count": 2, "total_timeout": 1000, "frame_timeout": 0,
            "format": "HEX", "msg": "fefe4000"},
 "id": 2}
```

`id` is a monotonically increasing per-driver counter starting at 1. The driver
never reads a reply, so nothing has to be published back on
`/rpc/v1/.../port/Load/<client>/reply`.

### Payload layout

```
address = queue_start_modbus_address + (bus-1)*1000 + start_index*2   # wbdali.py:1108-1112
count   = len(items) * 2                                              # 2 holding regs per slot
msg     = concat over items of  f"{((raw32 & 0xFFFF) << 16) | (raw32 >> 16):08x}"   # wbdali.py:1107
```

i.e. per slot the **low 16 bits of the encoded 32-bit word go into the lower
Modbus address, the high 16 bits into the next** (little-endian *word* order,
big-endian bytes inside a word — `msg` is parsed by wb-mqtt-serial as a plain
byte stream, `rpc_port_load_request.cpp:19-31`). No slot count, no pointer, no
terminator: writing the slots *is* the trigger.

### Queue reset

`_reset_queue_in_gateway` (wbdali.py:627-640) — issued once from `initialize()`
and again lazily before the first batch after the gateway comes back
(`_pending_resync`, wbdali.py:1072-1074):

```json
{"params": {"device_id": "wb-dali_1", "function": 6, "address": 1432,
            "count": 1, "total_timeout": 1000, "frame_timeout": 0,
            "format": "HEX", "msg": "0000"}, "id": 1}
```

fc 6 = write single holding register, value 0. The driver *never* advances the
pointer itself — the gateway owns it. So the emulator's contract is: **writing 0
to `1432 + bus_off` rewinds the gateway's consume pointer to slot 0; every write
into `1400 + bus_off + 2i` makes slot *i* pending, and the gateway transmits
pending slots in increasing index order, wrapping 15 → 0.**

### Worked examples (real output, `exp1.py` driving the real driver)

`DAPC(Broadcast(), 254)` at default priority `USER_ACTION` (=2), fresh queue:

```
frame  FF16 0x00FEFE   sendtwice=False   response=None
raw32  = 0x4000FEFE     (prio 2<<29 | size 0<<25 | 0xFEFE)
regs   [1400] = 0xFEFE   [1401] = 0x4000
RPC    function=16 address=1400 count=2 msg="fefe4000"
```

`QueryDeviceType(Short(0))` as the next batch (slot 1):

```
frame  FF16 0x000199   sendtwice=False   response=QueryDeviceTypeResponse
raw32  = 0x40000199
regs   [1402] = 0x0199   [1403] = 0x4000
RPC    function=16 address=1402 count=2 msg="01994000"
```

Reply `bus_1_bulk_send_reply_1 = 342` (0x0156) → driver resolves the future with
`QueryDeviceTypeResponse(BackwardFrame(0x56))`.

Three-command batch (from `test_wbdali.py:255-290`, data `0x1234/0x5678/0x9abc`,
priority `AUTOMATIC`): `count=6`, `msg="12348000567880009abc8000"`, slots 0,1,2.

---

## 3. Frame encoding — `encode_frame_for_modbus()`

wbdali.py:409-451.

```
bits [24..0]  frame data, right-aligned (frame_int & 0x1FFFFFF)
bits [27..25] frame size code
bit  [28]     send twice
bits [31..29] priority (FramePriority value; 0 would mean "do not send")
```

Size codes (wbdali.py:433-440): **FF16 → 0, FF24 → 1, FF25 → 2**; any other
length raises `ValueError`. There is **no code for BF8** — backward frames are
never sent by the host; BF8 only appears in the *reply* and *monitor* registers.

Priorities (`FramePriority`, wbdali.py:50-68, IEC 62386-103:2022 §9.14.1):
`TRANSACTION_CONTINUATION=1`, `USER_ACTION=2` (driver default),
`CONFIGURATION=3`, `AUTOMATIC=4`, `PERIODIC_QUERY=5`. Auto-promotion to 1 for
frames continuing a DTR / `EnableDeviceType` transaction is done in
`_compute_frame_priorities` (wbdali.py:1179-1207).

Verified values (computed, and pinned by `test_wbdali.py:137-171`):

| frame | sendtwice | priority | raw32 | `msg` words |
|---|---|---|---|---|
| FF16 0x1234 | no | AUTOMATIC(4) | `0x80001234` | `12348000` |
| FF24 0x123456 | no | AUTOMATIC(4) | `0x82123456` | `34568212` |
| FF25 0x1234567 | no | AUTOMATIC(4) | `0x85234567` | `45678523` |
| FF16 0x1234 | **yes** | AUTOMATIC(4) | `0x90001234` | `12349000` |
| FF16 0x00FEFE `DAPC(bc,254)` | no | USER_ACTION(2) | `0x4000FEFE` | `fefe4000` |
| FF16 0x000199 `QueryDeviceType(A0)` | no | USER_ACTION(2) | `0x40000199` | `01994000` |
| FF16 0x00FF00 `Off(bc)` | no | USER_ACTION(2) | `0x4000FF00` | `ff004000` |
| FF16 0x00C108 `EnableDeviceType(8)` | no | USER_ACTION(2) | `0x4000C108` | `c1084000` |
| FF16 0x00A3FF `DTR0(255)` | no | USER_ACTION(2) | `0x4000A3FF` | `a3ff4000` |

Note the data mask is `0x1FFFFFF` = bits [24..0], exactly 25 bits, so FF25 data
never collides with the size field: `0x1234567 | (2<<25) | (4<<29) = 0x85234567`.

---

## 4. Reply path — what the emulator MUST publish

`_handle_reply_message`, wbdali.py:705-896.

### Value layout (u16 input register `1500 + bus_off + i`)

```
[7..0]   backward frame byte (BF8), 0 when there is none
[15..8]  status
```

| status | meaning | driver result |
|---|---|---|
| 0 | no transmission (internal gateway error) | `NoTransmission()` |
| 1 | transmission **with** backward response | `cmd.response(BackwardFrame(byte))`, or `Response(BackwardFrame(byte))` if `cmd.response is None` |
| 2 | transmission **without** response | `cmd.response(None)` / `Response(None)` |
| 3 | broken response (framing error) | `cmd.response(BackwardFrameError(byte))` / `Response(BackwardFrameError(byte))` |
| 4 | transmission impossible — no power on bus | `NoPowerOnBus()` |
| 5 | gateway overheat | `Overheat()` + `OverheatRateLimiter.on_overheat()` |
| other | — | `UnknownResponseStatus()` |

No other bits are read. The register is `u16` in the template, and only
`resp & 0xFFFF` is ever decoded (`backward_frame_byte = resp & 0xFF`,
`status = (resp >> 8) & 0xFF`). An unparseable payload ⇒
`WbGatewayTransmissionError()` resolved immediately (wbdali.py:752-763).

**A command that expects no answer gets status 2 with byte 0, i.e. value
`0x0200` (decimal `512`)** — that is exactly what `test_frame_priority.py:147-152`
injects for successful non-query frames. Do *not* use status 0 for that; status 0
means the gateway failed to transmit.

### Correlation

Purely positional. The slot index is parsed out of the **topic name**
(wbdali.py:736-740):

```python
resp_pointer = int(str(message.topic).rsplit("/", 1)[-1]
                   .replace(f"bus_{bus}_bulk_send_reply_", ""))
```

and looked up in `self._waiting_for_responses: dict[int, WaitResponseItem]`,
which `_send_to_gateway` populated with `current_index = start_index + n`
(wbdali.py:1076, 1099-1101). Slot *i* of the gateway queue ⇔ the 32-bit word the
driver wrote at `1400 + bus_off + 2i`. Nothing in the payload identifies the
command.

Bookkeeping:

* entries are **never deleted** on success — they are overwritten when the slot
  is reused, and wiped only by `_reset_queue_state_locally` (wbdali.py:687-690),
  `_drain_pending_with_gateway_unavailable` (wbdali.py:671-685) and
  `deinitialize` (wbdali.py:574-578);
* a reply for a slot with no waiter logs `Received response for unknown pointer`
  and is dropped;
* a reply for a slot whose future is **already done** is silently ignored
  (wbdali.py:748-750) — republishing an unchanged value is harmless *for the
  same command*, but **fatal if the slot has since been rewritten**: the driver
  would take the stale value as the new command's answer. Therefore the emulated
  poller must publish a reply register **only when the gateway has just written
  it** (event semantics, matching `"sporadic": true`), never on a bare periodic
  re-read.

### Exact emulator contract for resolving a future

For each command word the driver wrote at `1400 + (bus-1)*1000 + 2i`:

1. transmit it on the DALI bus model;
2. compute `value = (status << 8) | backward_byte`;
3. publish `value` as a **decimal ASCII string** (`get_int_payload` uses
   `int(payload, 0)`, so `"512"` and `"0x200"` both work) on
   `/devices/<device_name>/controls/bus_<bus>_bulk_send_reply_<i>`
   with **`retain` false as delivered** (`_handle_reply_message` drops
   `message.retain` messages, wbdali.py:720-722 — a real broker only sets that
   flag on the subscribe-time replay, so publishing retained through a broker is
   fine; a direct in-process injection must set `retain=False`);
4. do it within `WAIT_DALI_RESPONSE_TIMEOUT_S = 1.5 s` of the write, otherwise
   the driver's `call_later` fires `NoResponseFromGateway` (wbdali.py:1078-1098).

Publish replies **in slot order**; the driver tolerates out-of-order replies for
its futures, but `BusTrafficCallbacks.notify_command` buffers and reorders on
`sequence_id` (bus_traffic.py:53-100) and will stall the bus-traffic stream
across a gap of more than `queue_size` items.

---

## 5. Bus monitor ring — `bus_N_monitor_sporadic_frame_1..4`

Four u64 input registers, 4 Modbus registers each, `word_order: little_endian`
(⇒ register at the lowest address holds bits [15..0], see wb-mqtt-serial
`README.md:432-434`):

```
addr+0 → value[15..0]   addr+1 → value[31..16]
addr+2 → value[47..32]  addr+3 → value[63..48]
```

Bus 1 slots: 1900, 1904, 1908, 1912 (bus 2: 2900…, bus 3: 3900…).

### Value layout (`BusMonitorSlot.from_raw`, wbdali.py:144-158)

```
[63..48] frame counter, mod 2**16   (FRAME_COUNTER_MODULO, wbdali.py:78)
[47..42] unused (never read)
[41]     broken / framing error
[40]     is_backward
[39..32] frame length in bits
[31..25] unused
[24..0]  frame data, masked with (1 << frame_length) - 1
```

`raw_value == 0` ⇒ empty slot, ignored silently (wbdali.py:160-163, 237-239).
Valid lengths: backward ⇒ exactly 8; forward ⇒ 16, 24 or 25
(`FORWARD_FRAME_BIT_LENGTHS`, wbdali.py:98-99). Anything else logs
`Bus monitor slot holds no DALI frame` and is never published.

Computed examples (verified round-trip through `BusMonitorSlot` and
`BusMonitorFrameHandler`):

| what | raw u64 | LE words at addr+0..+3 |
|---|---|---|
| FF16 `DAPC(bc,254)`, fc 100 | `0x006400100000FEFE` | `FEFE 0000 0010 0064` |
| FF24 event `0xFE0A01`, fc 101 | `0x0065001800FE0A01` | `0A01 00FE 0018 0065` |
| BF8 `0x56`, fc 102 | `0x0066010800000056` | `0056 0000 0108 0066` |
| BF8 broken `0xFF`, fc 103 | `0x00670308000000FF` | `00FF 0000 0308 0067` |
| FF25 `0x1234567`, fc 104 | `0x0068001901234567` | `4567 0123 0019 0068` |

Payload on MQTT is the decimal u64, e.g. `28147566390607614`.

### Ring + reordering semantics (`BusMonitorFrameHandler`, wbdali.py:182-388)

The gateway writes each observed frame into the next of the 4 slots
(round-robin) and bumps a global 16-bit `frame_counter`. wb-mqtt-serial may read
and publish the slots out of counter order, so the handler reorders:

* `BUS_MONITOR_RING_SIZE = 4`, `BUS_MONITOR_REORDER_WINDOW = 3`
  (`ring_size - 1`), `BUS_MONITOR_RESYNC_AFTER_FRAMES_BEHIND = 4`.
* First valid slot ever seen sets `_next_expected_fc = fc + 1` and is published.
* `distance = (fc - expected) mod 65536`:
  * `0` → publish, then drain contiguous buffered successors;
  * `1..3` → buffer, wait for the gap to close (no warning);
  * `4 .. 32767` → real gap: flush all buffered slots in counter order, warn
    `frame counter jump from X to Y, N frame(s) missed`, publish, jump
    `expected = fc + 1`;
  * `≥ 32768` (i.e. behind expected) → drop with a warning; if 4 *distinct*
    such counters accumulate while each is more than `RING_SIZE` behind, the
    handler decides its own cursor was wrong and **resynchronises** to the last
    one (the only case where the dispatched counter goes backwards).
* An **invalid** slot still consumes its counter when it lands on `expected` or
  inside the window, but a far-forward invalid slot is not trusted
  (wbdali.py:280-288).
* Messages with `retain=True` or an empty payload are ignored (wbdali.py:223).

**Emulator rule:** keep one 16-bit counter per bus; for each frame actually seen
on the wire (both the frames the gateway itself sends and any it observes),
write `(fc << 48) | (broken << 41) | (backward << 40) | (len << 32) | data` into
ring slot `n % 4`, increment `fc`, and publish that slot's topic. Publishing
strictly in counter order into slots `1,2,3,4,1,2,…` produces zero warnings.
Note the driver only *logs* these frames plus feeds `BusTrafficCallbacks`
(wbdali.py:364-388) — DALI-2 input-device events reach the application through
this path, so an emulator that wants button/sensor events must use the ring.

---

## 6. Availability and error handling

### `/devices/<device_name>/meta/error`

`_handle_meta_error_message`, wbdali.py:642-669. wb-mqtt-serial publishes this
**retained**, and unlike the reply/monitor handlers this one does *not* skip
retained messages — a late-starting driver picks up the current state on
subscribe (`MQTTDispatcher._retained_cache` also replays it to a second callback
on the same topic, mqtt_dispatcher.py:26-45).

| payload | `GatewayMetaErrorPayload` | effect |
|---|---|---|
| `"r"` | `UNREACHABLE` | `_gateway_unavailable = True`; every in-flight waiter is resolved with `GatewayUnavailable()` and its timeout cancelled (`_drain_pending_with_gateway_unavailable`, wbdali.py:671-685); `_waiting_for_responses` cleared |
| `""` | `OK` | `_reset_queue_state_locally()` (`_next_queue_index = _batch_start_index = 0`, waiters cleared), `_pending_resync = True`, `_gateway_unavailable = False`. The gateway-side reset (fc 6 → 0 into 1432) is **deferred to the next batch** |
| anything else (`p`, `w`, …) | — | logged at debug, ignored |

Transitions are idempotent (early-return at wbdali.py:658-659). While
unavailable, `_send_commands_internal` fails fast: it returns
`GatewayUnavailable()` for every command *without* enqueuing, but still emits
bus-traffic notifications and advances `_send_queue_item_index` so the
`BusTrafficCallbacks` sequence stays contiguous (wbdali.py:1129-1135). Batches
already queued when the flag flips are failed in `_send_to_gateway`
(`_fail_batch_gateway_unavailable`, wbdali.py:692-703, 1069-1071).

`GatewayUnavailable` and friends all subclass `WbGatewayTransmissionError`
(`wbdali_error_response.py`); `.value` / `.raw_value` raise `RuntimeError` so
callers cannot mistake them for data.

### Overheat (status 5) and the rate limiter

`OverheatRateLimiter` (overheat_rate_limiter.py). Any reply with `status == 5`
calls `on_overheat()`; **any other status** calls `on_non_overheat_response()`
(wbdali.py:768-769, 869).

* `on_overheat()` → `cooldown_until = now + 10 s` (`OVERHEAT_COOLDOWN_S`),
  `recovery_step = 0`.
* `_send_to_gateway` starts with `await self._overheat_rate_limiter
  .wait_before_send()` (wbdali.py:1068), which sleeps until the cooldown expires
  and then throttles: `recovery_steps = 6`, `first_interval_s = 1.0`, interval
  `= 1.0 * (6 - step) / 5` — so after the cooldown the driver sends at most one
  batch per 1.0 s, then 0.8, 0.6, 0.4, 0.2 s, and at step ≥ 6 it is unthrottled
  again. Each non-overheat reply advances one step.

For the emulator, status 5 is the lever to make the UI exercise a 10 s freeze;
use it sparingly (or behind a "simulate overheat" toggle).

---

## 7. Timing

Constants (wbdali.py:74-76):

```python
WB_MQTT_SERIAL_PORT_LOAD_TOTAL_TIMEOUT_MS = 1000   # total_timeout in the RPC envelope
WAIT_DALI_RESPONSE_TIMEOUT_S = 1.5 * 1000 / 1000 = 1.5   # per-slot reply deadline
WAIT_COMMANDS_FOR_BATCH_TIMEOUT_S = 0.01                 # batch coalescing window
```

`response_timeout` is a settable property (wbdali.py:506-517) applied at dispatch
time; items already in flight keep the timeout they were scheduled with.

Real DALI wire timing (IEC 62386-101, Te = 416.67 µs, 1 bit = 2 Te):

| event | duration |
|---|---|
| FF16 (1 start + 16 data bits) + stop condition | ≈ 15.8 ms |
| FF24 | ≈ 22.5 ms |
| BF8 | ≈ 9.2 ms |
| settling forward → backward | 5.5 – 10.5 ms |
| settling before next forward frame | ≥ 5.5 ms (≥ 13.5 ms multi-master) |
| send-twice repeat gap | ≤ 100 ms |

So a query round trip ≈ 32-40 ms, a fire-and-forget command ≈ 22-30 ms, a
send-twice pair ≈ 50-60 ms. A full 16-slot batch of queries ≈ 0.6 s — comfortably
inside the 1.5 s per-slot deadline, but a batch of send-twice configuration
commands can approach it.

**Recommendation for a browser-hosted emulator.** Make the delay a single knob,
default to something like 1/10 of reality but keep the *ordering and the
batching* exact:

* `frame_time(cmd)`: `~2 ms` for FF16, `~2.5 ms` FF24, `+1 ms` if a backward
  frame is produced, `×2 + 1 ms` for send-twice. Fast enough that a UI click
  feels instant, slow enough that the driver's 10 ms batch window and the
  16-slot back-pressure path are genuinely exercised (a batch of 16 then takes
  ~32 ms — still under 10 ms per slot, so add a small per-slot floor if you want
  the back-pressure branch at wbdali.py:1010-1021 to trigger).
* Keep an explicit **`slow_factor`** (1.0 = real DALI) so a test can run the
  emulator at wire speed and confirm the driver's timeouts/retries behave.
* Provide deliberate fault injection rather than relying on real slowness:
  a per-command probability (or an explicit script) of status 0 / 3 / 4 / 5, of
  *dropping* the reply entirely (exercises `NoResponseFromGateway` after 1.5 s),
  and of toggling `/meta/error` to `r`.
* Never make a single reply take longer than 1.5 s unless you *want*
  `NoResponseFromGateway`.

---

## 8. Emulator contract

### 8.1 Modbus surface

The requested signature is not quite enough: **replies and monitor slots are
`input` registers (fc 4), only the send queue and the pointer are `holding`**.

```python
class VirtualWbDaliGateway:
    def __init__(self, buses: dict[int, "VirtualDaliBus"], *, queue_size: int = 16,
                 slow_factor: float = 0.1) -> None: ...

    # --- Modbus ---
    def read_holding(self, address: int, count: int) -> list[int]: ...   # fc 3
    def write_holding(self, address: int, values: list[int]) -> None: ...# fc 6 / fc 16
    def read_input(self, address: int, count: int) -> list[int]: ...     # fc 4
    def read_discrete(self, address: int, count: int) -> list[bool]: ... # fc 2 (bus state/overheat/powered)
    def write_coil(self, address: int, value: bool) -> None: ...         # fc 5 (bus power supply)

    # --- driven by the host event loop ---
    async def run(self) -> None: ...        # transmit pending slots, honouring frame timing
    def drain_dirty(self) -> list[tuple[int, int]]: ...  # (input-register address, value) written since last call

    # --- test hooks ---
    def inject_bus_frame(self, bus: int, frame: Frame) -> None: ...  # 3rd-party frame → monitor ring
    def set_bus_powered(self, bus: int, powered: bool) -> None: ...
    def set_overheat(self, bus: int, overheat: bool) -> None: ...
```

Address decode (`bus = address // 1000`, `off = address % 1000`, bus ∈ 1..3):

```
400 <= off <= 431  →  send-queue slot (off-400)//2, word (off-400)%2   [holding, write]
off == 432         →  bulk-send pointer                                 [holding, r/w]
500 <= off <= 515  →  reply slot off-500                                [input]
900 <= off <= 915  →  monitor ring slot (off-900)//4, word (off-900)%4  [input]
```

Both the queue slots and the monitor slots use **little-endian word order**
(lowest address = least significant 16 bits).

### 8.2 Gateway state machine (per bus)

```
pending[16]: bool      # slot has an unconsumed command word
words[16]:   int       # 32-bit encoded frame
reply[16]:   int       # last published reply value
ptr:         int       # consume pointer, 0..15
fc:          int       # 16-bit bus-monitor frame counter
ring[4]:     int       # monitor slot values
dt:          int       # device type armed by the last EnableDeviceType (0 = none)
```

* `write_holding(1432+bus_off, [0])` → `ptr = 0`, clear all `pending`
  (this is the driver's `_reset_queue_in_gateway`).
* `write_holding(1400+bus_off+2i, [lo, hi])` → `words[i] = (hi<<16)|lo`,
  `pending[i] = True`. The driver always writes whole slots starting at an even
  offset, so a simple pairwise assembly is safe.
* Transmit loop: while `pending[ptr]`, transmit `words[ptr]`, write
  `reply[ptr]`, mark that input address dirty, `pending[ptr] = False`,
  `ptr = (ptr+1) % 16`. Consume strictly in pointer order — the driver's
  positional correlation depends on it.

Transmitting one word:

```python
prio     = (w >> 29) & 0x7          # 0 → do not transmit (leave the slot silent)
twice    = bool((w >> 28) & 0x1)
size     = {0: 16, 1: 24, 2: 25}[(w >> 25) & 0x7]
data     = w & ((1 << size) - 1)
frame    = ForwardFrame(size, data)
```

Then:

1. if the bus is not powered → `reply = 0x0400` (status 4), stop;
   if overheat is simulated → `reply = 0x0500` (status 5), stop;
2. `cmd = from_frame(frame, devicetype=dt, dev_inst_map=dev_inst_map)`;
   then `dt = cmd.param if isinstance(cmd, EnableDeviceType) else 0`
   — this is mandatory: `fakes.Gear` explicitly assumes "device type decoding
   has already been handled" (fakes.py:376-381), so `QueryColourValue` decodes
   as `UnknownGearCommand` without it (verified);
3. deliver to the bus model **once** even when `twice` is set — `fakes.Gear`
   applies configuration commands on a single `send()` and has no `sendtwice`
   notion; account the extra frame only in the timing;
4. collect responders, build the status word.

### 8.3 Driving the DALI bus model

`fakes.Gear.send(cmd)` / `fakes.Device.send(cmd)` take a **decoded `Command`
object** and return `None` or an `int` in 0..255 (fakes.py:98-103, 460-466).
`fakes.Bus.send()` (fakes.py:645-655) is *not* directly reusable — it returns
`cmd.response(rf)`, a `Response`, and swallows the raw byte we need. Replicate
its arbitration instead:

```python
def transmit(self, frame, cmd):
    if len(frame) == 16:
        targets = self.gear          # control gear answer only 16-bit frames
    elif len(frame) == 24:
        targets = self.devices       # control devices answer only 24-bit frames
    else:
        targets = []                 # FF25 — nothing decodes or answers it
    answers = [r for r in (t.send(cmd) for t in targets) if r is not None]
    if len(answers) > 1:
        return 3, answers[0] & 0xFF          # collision → broken response
    if len(answers) == 1:
        return 1, answers[0] & 0xFF          # backward frame
    return 2, 0                              # transmitted, no answer
```

`fakes.Gear.valid_address` already rejects non-16-bit frames and
`fakes.Device.valid_address` non-24-bit ones (fakes.py:147-163, 507-522), so
passing everything to everything also works; the split above just avoids the
`dt_gap` bookkeeping in `Gear.send` being disturbed by 24-bit traffic.

Status 0 (`no transmission`) and dropped replies are the fault-injection knobs;
the honest bus model never produces them.

### 8.4 Bus monitor ring

Do **not** put the gateway's own transmissions into the ring: `_log_frame`
(wbdali.py:375-388) labels every non-event forward frame "Unexpected", and
`BusTrafficCallbacks` already receives those frames through the reply path — so
echoing them would double every command in bus traffic. (This also matches
`e2e/on_latency` needing a *second* WB-DALI on the bus to observe the first
one's DAPC frames.) Use the ring for third-party traffic: DALI-2 input-device
events, other masters, and anything `inject_bus_frame()` is given.

```python
def push_monitor(bus, frame, *, broken=False):
    st = bus.ring_index                      # 0..3, round-robin
    value = ((bus.fc & 0xFFFF) << 48) | (broken << 41) | \
            ((len(frame) == 8) << 40) | (len(frame) << 32) | frame.as_integer
    bus.ring[st] = value
    bus.fc = (bus.fc + 1) & 0xFFFF
    bus.ring_index = (st + 1) % 4
    mark_dirty(1900 + bus_off + 4*st)
```

### 8.5 What the emulated wb-mqtt-serial poller must do

**Subscribe** to `/rpc/v1/wb-mqtt-serial/port/Load/+` (the driver appends a
random per-driver suffix to the client id, so a wildcard is required); parse
`params.device_id / function / address / count / msg` and apply:
`function 6` → `write_holding(address, [int(msg,16)])`,
`function 16` → `write_holding(address, [int(msg[4i:4i+4],16) for i in range(count)])`.
No RPC reply is needed.

**Publish** (topic prefix `/devices/<device_id>/`):

| topic | payload | when |
|---|---|---|
| `meta/error` | `""` (retained) | at start-up, and whenever the gateway becomes reachable again |
| `meta/error` | `"r"` (retained) | while simulating an unreachable gateway |
| `controls/bus_<N>_bulk_send_reply_<i>` | decimal `(status<<8)\|byte` | **once per gateway write of that slot** — never on a bare re-read |
| `controls/bus_<N>_monitor_sporadic_frame_<r>` | decimal u64 | once per ring write |
| `controls/bus_<N>_bulk_send_pointer` | decimal `ptr` | optional; nothing in the driver reads it |

Registers a literal poller would read (per bus, `bus_off = (bus-1)*1000`):

```
fc 4  input   1500+bus_off .. 1515+bus_off   (16 regs)  → bulk_send_reply_0..15
fc 4  input   1900+bus_off .. 1915+bus_off   (16 regs)  → monitor_sporadic_frame_1..4
fc 3  holding 1432+bus_off                   (1 reg)    → bulk_send_pointer
optional realism: fc 2 discrete 1000/1010/1020/1030+ch, fc 4 input 4020+ch (temperature)
```

**Cadence:** a 10-20 ms tick is right. It must be far below
`WAIT_DALI_RESPONSE_TIMEOUT_S = 1.5 s`, and the driver's 10 ms batch-coalescing
window means anything slower starts to distort batching. Publish the reply for a
slot as soon as the gateway has written it; keep the publishes for one batch in
slot order so `BusTrafficCallbacks` does not have to reorder. Do not publish a
reply register for a slot the gateway has not consumed since the last write —
that is the one way to make the driver resolve a future with the wrong answer.

### 8.6 Minimal happy-path trace

```
driver  → RPC fc6  addr 1432  msg "0000"                      # initialize()
gateway   ptr = 0, pending cleared
driver  → RPC fc16 addr 1400  count 2  msg "fefe4000"         # DAPC(broadcast, 254)
gateway   words[0] = 0x4000FEFE → prio 2, FF16, data 0x00FEFE
          from_frame → DAPC(<broadcast>, 254); Gear.send → None
          reply[0] = 0x0200
poller  → /devices/wb-dali_1/controls/bus_1_bulk_send_reply_0  "512"
driver    future resolved with Response(None)
driver  → RPC fc16 addr 1402  count 2  msg "01994000"         # QueryDeviceType(A0)
gateway   words[1] = 0x40000199 → FF16 0x000199
          from_frame → QueryDeviceType(A0); Gear(0).send → 8
          reply[1] = 0x0108
poller  → /devices/wb-dali_1/controls/bus_1_bulk_send_reply_1  "264"
driver    future resolved with QueryDeviceTypeResponse(BackwardFrame(8)) → value 8
```

### 8.7 Verified end-to-end

A ~60-line prototype of §8.2/§8.3 (Appendix A) wired to the **real**
`WBDALIDriver` and two `fakes.Gear` (short 0 with `devicetypes=[8]`, short 1
with none) produced, unmodified:

```
slot decoded command                          prio twice raw32       reply
 0   ArcPower(<broadcast>,254)                  2   False 0x4000fefe  0x0200
 1   QueryActualLevel(<gear 0>)                 2   False 0x400001a0  0x01fe
 2   QueryDeviceType(<gear 0>)                  2   False 0x40000199  0x0108
 3   QueryDeviceType(<gear 1>)                  2   False 0x40000399  0x01fe
 4   QueryActualLevel(<broadcast>)              2   False 0x4000ffa0  0x03fe   <- collision
 5   EnableDeviceType(8)                        2   False 0x4000c108  0x0200
 6   QueryColourValue(<gear 0>)                 1   False 0x200001fa  0x0100   <- prio auto-promoted
```

and the driver returned `254`, `BackwardFrame(8)`, `BackwardFrame(254)`,
a `BackwardFrameError(254)` for the broadcast collision, and a decoded DT8
`QueryColourValue` response. Note slot 5/6: the driver inserted
`EnableDeviceType(8)` on its own and promoted the following frame to
`TRANSACTION_CONTINUATION` (priority 1, `0x2000...`), exactly as §3 describes.

---

## Appendix A — working prototype (verified against the real driver)

Synchronous, no timing model; enough to prove the wire contract. Run with
`PYTHONPATH=/tmp/wb-mqtt-dali`.

```python
from dali.command import from_frame
from dali.frame import ForwardFrame
from dali.gear.general import EnableDeviceType

class Gateway:
    """One DALI bus of a WB-DALI gateway. bus_off = (bus-1)*1000."""
    def __init__(self, gear, bus=1):
        self.gear, self.bus_off = gear, (bus - 1) * 1000
        self.words = [0] * 16; self.pending = [False] * 16; self.reply = [0] * 16
        self.ptr = 0; self.dt = 0; self.dirty = []

    def write_holding(self, address, values):
        off = address % 1000
        if off == 432:                       # bulk send pointer: only 0 is ever written
            self.ptr = 0; self.pending = [False] * 16; return
        assert 400 <= off <= 431 and (off - 400) % 2 == 0 and len(values) % 2 == 0
        slot = (off - 400) // 2
        for k in range(0, len(values), 2):
            i = (slot + k // 2) % 16
            self.words[i] = (values[k + 1] << 16) | values[k]   # little-endian word order
            self.pending[i] = True

    def step(self):
        while self.pending[self.ptr]:
            i, w = self.ptr, self.words[self.ptr]
            size = {0: 16, 1: 24, 2: 25}[(w >> 25) & 7]
            frame = ForwardFrame(size, w & ((1 << size) - 1))
            # (w >> 29) & 7 == priority, 0 would mean "do not send"; (w >> 28) & 1 == sendtwice
            cmd = from_frame(frame, devicetype=self.dt)
            self.dt = cmd.param if isinstance(cmd, EnableDeviceType) else 0
            answers = [r for r in (g.send(cmd) for g in self.gear) if r is not None] \
                      if size == 16 else []
            if len(answers) > 1:   status, byte = 3, answers[0] & 0xFF   # collision
            elif len(answers) == 1: status, byte = 1, answers[0] & 0xFF  # backward frame
            else:                   status, byte = 2, 0                  # sent, no answer
            self.reply[i] = (status << 8) | byte
            self.dirty.append((1500 + self.bus_off + i, self.reply[i]))
            self.pending[i] = False
            self.ptr = (self.ptr + 1) % 16
```

Fake wb-mqtt-serial side (on every `/rpc/v1/wb-mqtt-serial/port/Load/+` publish):

```python
p = json.loads(payload)["params"]
if p["function"] == 6:
    gw.write_holding(p["address"], [int(p["msg"], 16)])
else:  # 16
    gw.write_holding(p["address"], [int(p["msg"][4*i:4*i+4], 16) for i in range(p["count"])])
gw.step()
for addr, val in gw.dirty:                       # publish only freshly written slots
    i = addr - 1500 - bus_off
    publish(f"/devices/{DEV}/controls/bus_{BUS}_bulk_send_reply_{i}", str(val), retain=False)
gw.dirty.clear()
```
