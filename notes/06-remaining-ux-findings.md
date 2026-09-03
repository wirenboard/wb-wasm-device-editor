# UX review: findings deferred for later

From the 2026-08-29 UI/UX review against real hardware. The must-fix list and
the small our-code polish items (16, 17, 18, 23) are done; this records what
remains, with triage. Screenshots referenced live in /tmp/uxr-*.png of the
review session (ephemeral — re-shoot if needed).

## Needs a product/design decision first (homeui's DALI page — fixes belong upstream)

| # | Finding | Size | Notes |
|---|---|---|---|
| 9 | ~15 identical bright-green "Set" buttons per bus/group/device form, attached to the *label* rather than the control, no unsaved-change indication | M | Suggest secondary styling, Set after its control, enabled only when dirty |
| 10 | Unlabeled MASK toggle fused to the left end of sliders; "Power on level" shows two knobs on one track and reads as a range slider | S–M | Label the toggle (a "MASK" chip) as the colour rows already do |
| 12 | MSensor page is a ~14,500 px wall: 20 instances (16 near-identical push-buttons) all expanded, full event-filter checklists each | M | Collapse instances by default; header shows type + state. Also render "Primary instance group: 255" as "None (255)" |
| 13 | No heading in the DALI content pane — bus/device/group pages rely on tree selection for identity, and at ≤800 px the tree is hidden, so a device page has *no indication which device it is* | S | Highest value per line of the homeui batch |
| 14 | Group pages show broadcast-style parameters but no member list and no membership editing | S–M | Members are already known client-side (device.groups) |
| 15 | DALI-2 device init paints the monitor viewport solid red with expected FF24.F32 probe failures ("no response" ×3 per instance) | S | Collapse repeated identical rows with a ×N badge, like foreign frames |
| 8 | Bus Monitor docked right is unusable at its 370 px default: every command truncates to "L…", response to "25…" | S | Wider default; smarter column truncation; badge after name |
| 19 | Off-state toggles (white fill, green border/knob) read as semi-active | XS | Gray for off — global homeui Switch styling |
| 21 | False precision: "Max level 2.128%", "System failure level 0.115%", "Fade Rate 44.7 / 358 steps/s" | XS | One decimal; keep raw DALI value in parentheses as fast-fade already does |
| 22 | Colour-lamp Scenes table renders empty RGB/W columns when MASKed | XS | Dash or MASK chip in-cell |
| 24 | "Save to syslog" — no syslog exists in a browser; unclear where it saves even on a controller | XS | Rename to say where the log goes |

## Upstream wb-mqtt-dali (daemon)

| # | Finding | Fix |
|---|---|---|
| 2 | Two identically-titled "Scenes" sections on bus/group pages (light-level `GroupScenesSettings` vs DT8 `ColourGroupScenesSettings`, both "Scenes"/«Сцены») — a data-loss trap; reproduces on real controllers too | One-line title rename in `dali_type8_parameters.py` (e.g. "Colour scenes"/«Цветовые сцены») |

## ~~The one substantial project: identity caching (#11 and the root of #15)~~ — DONE

Shipped as `wasm/python/runtime/wbdali_browser/memory_cache.py`: memory-bank
bytes AND settings-shaped answers (scenes, groups, levels, identity words)
memoized per device, keyed by the random address the device answered with,
verified by a three-frame QUERY RANDOM ADDRESS before a restored memo is
trusted, invalidated by commissioning commands and (settings) by any config
write. Persisted alongside the config via the watch_config 3-tuple. What
remains of the idea below is only DALI-2 feature-absence caching.

Device pages re-read everything over the bus on every visit (5–10 s spinner,
unnarrated); boot init re-reads each device's immutable identity every session;
DALI-2 feature probing burns ~4 s per sensor per boot rediscovering absent
features. Same root cause: the daemon's in-memory knowledge dies with the page,
and at the ~46 ms/frame bus floor the only way to be faster is to not send
frames. Persist immutable facts (memory-bank identity, GTIN, versions, feature
absence) keyed by (random address, GTIN) next to the config we already persist,
seed them at boot exactly like group membership. Invalidation: a scan that
finds a different random address at a short address drops that device's cache.
Roughly a day of work in the runtime seed/persistence layer; halves cold
device-page opens and boot init, and pairs with the firmware pacing findings in
notes/05 for the full speedup story.

## Firmware (see notes/05-wb-mdali-firmware-pacing.md)

Pacing findings worth ~28% of every answered DALI query, plus a marginally
tight backward-frame timeout. Belongs with the firmware team.
