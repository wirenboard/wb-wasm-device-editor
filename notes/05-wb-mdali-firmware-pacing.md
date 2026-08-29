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
31.7. The queue side adds nothing: `dali_rx_complete_handler` writes the reply
register and schedules the next slot's send with delay 0.

## Findings, in order of impact

1. **The priority window is applied after backward frames too.**
   `dali_schedule_tx` measures from `last_edge_time_us` of *any* frame. The
   13.5–21.1 ms priority windows exist for forward-after-forward multi-master
   arbitration (IEC 62386-101 8.3.2); the settling required between a *backward*
   frame and the next forward is only **≥ 2.4 ms** (101 ed2, settling-times
   table — verify the exact table number before implementing). Applying ~3 ms
   after backward frames takes an answered query from 46 to **~33 ms (−28%)** —
   this single change is worth more than any transport-side work, and it is the
   exact headroom our batched-vs-spec-floor measurements predicted.

2. **`dali_schedule_tx` always waits to the window's `.max`.**
   A transmitter may start at its priority window's *beginning*; the end bounds
   when it must have deferred. Using `.min` saves 1.2–1.6 ms on every frame the
   priority window genuinely applies to (forward-after-forward), including all
   unanswered commands.

3. **Send-twice pairs also wait the full window.** After the first frame's echo,
   `stop_condition_handler` re-runs `dali_schedule_tx` with the same priority,
   so the twin frames sit ~16 ms apart. The spec constrains the pair's gap to
   ≤ 94 ms with the ordinary inter-frame minimum below it; ~3 ms here saves
   ~13 ms on every config command (INITIALISE, SetScene, AddToGroup… — bus
   scans are full of them).

4. **`WAIT_BACKWARD_TIMEOUT_US = 10000` is marginally tight.** The spec allows
   the backward frame to start up to 10.5 ms after the forward; a gear
   answering at 10.2 ms would be reported NO_ANSWER and its late backward
   would then be seen as a sporadic frame. 11 ms would be safe.

## Expected effect on the browser configurator (with driver batching already in)

| Flow | Today | With findings 1–3 |
|---|---|---|
| Answered query (the scan/read workhorse) | 47.8 ms | ~34 ms |
| Full bus rescan | 13 s | ~9 s |
| Cold device-page open | 10–20 s | ~7–14 s |

## Long-poll ("Lunatone DALI4Net style") — assessed against this source, not worth it

A holding-register read that blocks until the backward arrives would need
deferred-reply support in libwbmcu-modbus's polled machine, breaks the
wb-mqtt-serial ecosystem's timing expectations, and saves at most one Modbus
round trip (~9 ms) per frame — less than finding 1 alone, and only for
strictly sequential flows. The existing 16-slot queue plus pacing fixes beats
it in every scenario.
