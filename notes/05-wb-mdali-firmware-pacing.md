# WB-MDALI firmware: where the 46 ms per query goes, and what could be shaved

Source analyzed: `tmp/wb-mdali` (src/dali_bus_hw.c, src/dali_subsystem.c), against
timing measured over WebSerial on a real WB-DALI @115200 with Skydance gear:
an answered priority-2 query costs **46 ms** back-to-back on the DALI wire, an
unanswered command **31.7 ms**, and both numbers are baud-independent (re-measured
at 9600), so they are purely DALI-side.

## The measured 46 ms, reconstructed from source

| Phase | Time | Source |
|---|---|---|
| Forward frame, 1 start + 16 bits | 14.2 ms | `HALF_BIT_TIME_US 416` |
| Gear's answer delay (last fwd edge → backward start) | ~8 ms | the lamp's choice; spec window 5.5–10.5 ms |
| Backward frame, 1 start + 8 bits | 7.5 ms | wire |
| Settling before the next forward, **from the last backward edge** | **16.1 ms** | `priority_window_us[DALI_PROIRITY_2].max` in `dali_schedule_tx` |
| **Total** | **45.8 ms** | measured: 46 |

Unanswered: 14.2 ms forward + the same 16.1 ms window from the last *forward*
edge (the 10 ms `WAIT_BACKWARD_TIMEOUT_US` runs inside it) ≈ 30.3 ms — measured
31.7. The queue side adds nothing: `dali_rx_complete_handler` stores the reply
and schedules `dali_rx_process` with delay 0, which writes the reply register
and schedules `dali_next_send` with delay 0, on a free-running main loop.

Verified against `tmp/wb-mdali` @ `190cefc` (v1.0.2), and against
IEC 62386-101:2022 (Tables 17, 20, 22; 7.2.2; 8.2.5; 9.3; 9.4) on 2026-08-30.

The firmware's reference point matches the standard's: `last_edge_time_us` is
the last RX edge of whatever frame was on the bus (own echo included), and
101 §7.2.2 / §3.42 define the stop condition and the settling time as starting
at the last rising edge. So `time_from_last_edge_us` *is* the settling time
as the standard measures it.

## Findings, checked against IEC 62386-101:2022

**The earlier draft's headline finding (1) is wrong, and the −23…28 % it
promised does not exist.** Corrected findings, in order of impact:

1. **The full priority window after a backward frame is what the standard
   requires — not a shortcut to remove.**
   Table 22 (multi-master transmitter) is worded "settling time between
   *any frame* and forward frame (priority N)": 13.5–14.7 ms for priority 1
   up to 19.5–21.1 ms for priority 5, and footnote b extends it even to
   overlapping/corrupted backward frames. Table 17 (single-master) says the
   same — "any other frame and a forward frame: 13.5 ms minimum" — so
   there is no escape by declaring WB-MDALI single-master. The 5.5 ms figure
   note 02 quoted is the *forward → backward* window (the gear's answer
   delay), and the 2.4 ms figure is a *receiver* requirement (Table 20: what a
   receiver must accept as a forward frame), not a transmitter permission.
   `dali_schedule_tx` measuring from `last_edge_time_us` regardless of what
   the last frame was is therefore exactly right. The measured 46 ms answered
   query is ~1.5 ms above the standard's floor for priority 2, not 13 ms.

2. **`dali_schedule_tx` waits to the window's `.max`, then the 416 µs IRQ
   granularity pushes it past it.** The pended TX fires on the first
   `rx_timer` UIF tick with `time_from_last_edge_us >= 16 100`, so the frame
   actually starts 16.1–16.5 ms after the last edge — up to 0.4 ms *outside*
   the priority-2 slot and inside priority 3's (16.3–17.7 ms). Table 22
   footnote d tolerates it ("if the maximum settling time has already passed,
   the transmitter can start immediately"), but it means WB-MDALI can lose
   arbitration to a genuine priority-3 device. Footnote c says the transmitter
   should start "at a random point of time within the minimum and maximum
   settling time … clock tolerances need to be considered". Fix: schedule at
   `.min` plus a small random offset (e.g. 0–600 µs), which lands at
   14.9–15.9 ms — inside the slot — and saves ~0.9 ms average (1.2 ms at
   `.min` flat) on **every** frame, answered or not.

3. **Send-twice pairs: the second frame should go out at priority 1.**
   §9.4: a multi-master transmitter shall send the two identical frames "as a
   transaction"; §9.3: the first frame of a transaction carries priority 2–5,
   "all remaining forward frames of the transaction shall be sent with
   priority 1". `stop_condition_handler` re-runs `dali_schedule_tx` with the
   unchanged `tx_priority`, so the twin waits 16.1 ms where 13.5 ms is what
   the standard prescribes. That is −2.6 ms per config command (−3.8 with
   finding 2 on the first frame), and it is not merely allowed but the
   spec'd behaviour. (Upper bound on the gap: 75 ms for the transmitter,
   Table 17 footnote c; 94 ms is the receiver's acceptance limit, Table 20.)
   The earlier draft's ~3 ms twin gap remains invalid — the receiver-side
   2.4 ms is not a transmitter permission.

4. **`WAIT_BACKWARD_TIMEOUT_US = 10000` makes the receiver fail the
   Table 20 acceptance window** (independently re-verified 2026-08-30 from
   source + 101/103). §8.2.4 "a receiver shall accept frame sequences with
   the settling times given in Table 20"; Table 20: a frame starting
   2.4–12.4 ms after the forward frame's last rising edge "shall be
   interpreted as backward frame", 12.4–13.4 ms is the grey area, ≥ 13.4 ms
   "shall not" (§8.2.5). Clause 8.2 binds every receiver; a controller that
   sends queries has one (§4.6.4 NOTE, Table 2 note c). The check runs on the
   416 µs UIF tick, so today's cut-off is 10.0–10.4 ms (+IRQ latency) — short
   even of a gear's *legal* transmit maximum of 10.5 ms (Table 17), so a fully
   compliant gear answering at 10.4–10.5 ms is misreported today. A late
   answer is reported `NO_ANSWER` (single: `fail=0, len=0`; bulk:
   `SENDED_WITHOUT_ANSWER`) and then surfaces as `DALI_RX_SPORADIC` with
   `is_backward = 0`, `len = 8` in the sporadic ring (`wait_bf` and
   `tx_wait_notify` already cleared by the scheduler). No published 103
   conformance sequence exercises this window, which is why it went unnoticed.

   Fix: **12 500 µs** (effective 12.5–12.9 ms). 12 800 also sits in the grey
   area but leaves < 200 µs to the 13.4 ms "shall not" limit and to a foreign
   priority-1 forward frame (13.5 ms, Table 22) — which, caught with
   `wait_bf = 1`, would be delivered as our REPLY with `is_backward = 1`
   (`stop_condition_handler` does not check frame length).

   Pace cost: none in the normal case, but with less slack than the first
   draft said. The next forward is gated on `priority_window_us[].max` from
   the same last edge — 14.7 ms at priority 1, not 13.5 — and the
   NO_ANSWER → `dali_rx_process` → `dali_next_send` hop takes two main-loop
   passes (task index order), which must fit in 14.7 − 12.9 ≈ 1.5–2.2 ms
   (4.3 ms today). A main-loop stall (flashfs erase) would overrun; the cost is
   then only the overrun, since `tx_priority_timeout` stays set until 25 ms
   and `dali_schedule_tx` fires `tx_now`. **Interaction with finding 2:** with
   the gate moved to `.min` (13.5 ms at priority 1) the slack drops to
   0.3–0.7 ms, so expect occasional sub-ms TX delays on unanswered
   priority-1 frames — acceptable, but do findings 2 and 4 together and
   re-measure. Send-twice is unaffected (`wait_bf` is armed only after the
   second copy); the 100 ms `DALI_TIMEOUT_MS` backstop stays armed after
   NO_ANSWER and fires harmlessly, as today.

5. **Transactions / priority 1 for bursts — legal but not worth it.** §9.3
   lets a controller run a transaction's follow-up frames at priority 1
   (13.5 ms) as long as a single transaction stays ≤ 400 ms and successive
   transactions leave at least one gap longer than priority 5's max (21.1 ms)
   per 400 ms. Versus priority-2-at-`.min` that saves 1.4 ms per frame and
   gives back ~7 ms per 400 ms — net ≈ 2 %, and it needs the host to mark
   transaction boundaries. Not recommended.

## Expected effect on the browser configurator (with driver batching already in)

Findings 2 + 3 + 4; numbers are per-frame deltas applied to the measured
values, finding 2 taken at `.min` flat (random offset halves it).

| Flow | Today | With findings 2–4 |
|---|---|---|
| Answered query (the scan/read workhorse) | 47.8 ms | ~46.5 ms |
| Unanswered command | 31.7 ms | ~30.5 ms |
| Send-twice config command | ~61 ms | ~57 ms |
| Full bus rescan (mostly queries, ~280 frames) | 13 s | ~12.6 s |
| Cold device-page open (mostly queries) | 10–20 s | ~9.7–19.5 s |

In short: the firmware's pacing is already within ~1–2 ms per frame of what
IEC 62386-101 allows. The real firmware item is finding 4 (a correctness fix),
plus the small, spec-aligned trims of findings 2 and 3. Further speed-up has to
come from the host side (fewer frames: batching, caching, avoiding re-queries),
not from the wire.

## Long-poll ("Lunatone DALI4Net style") — assessed against this source, not worth it

A holding-register read that blocks until the backward arrives would need
deferred-reply support in libwbmcu-modbus's polled machine, breaks the
wb-mqtt-serial ecosystem's timing expectations, and saves at most one Modbus
round trip (~9 ms) per frame — and only for strictly sequential flows. The
existing 16-slot queue plus pacing fixes beats it in every scenario.
