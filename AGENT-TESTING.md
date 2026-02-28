# Agent Testing Guide

Manual verification of the UI using Chrome DevTools — either via MCP tools
(VM-local Chrome) or via CDP scripts (host Chrome with USB serial access).

## Two Chrome instances

There are two separate Chrome instances available:

| | VM-local Chrome (MCP) | Host Chrome (CDP) |
|---|---|---|
| **Where it runs** | Inside the Lima VM, started by MCP server | On the host machine, started by `run-chromium-sandbox.sh` |
| **How to connect** | MCP `chrome-devtools` tools (take_snapshot, click, etc.) | Python CDP scripts via WebSocket |
| **USB serial ports** | None | Yes (auto-granted by enterprise policy) |
| **Best for** | UI layout testing, screenshots, clicking through flows | Real hardware verification (scan, read device, runtime view) |

## Method 1: MCP chrome-devtools tools (layout testing)

Use MCP tools for quick layout verification — taking screenshots, checking
responsive behavior, clicking through UI flows. This Chrome has no USB serial
devices, so device loads will time out.

### Starting the app

**Dev server** (hot-reload, but no service worker):
```bash
cd wasm && npx vite --host 0.0.0.0
# → http://localhost:5173/
```

**Production build** (with service worker, closer to real deployment):
```bash
cd wasm && npm run build
cd dist-configurator && python3 -m http.server 3000 --bind 0.0.0.0
# → http://localhost:3000/
```

### Navigate and interact

```
# Navigate browser
mcp chrome-devtools navigate_page url="http://localhost:5173/"

# Take accessibility snapshot (preferred over screenshot for understanding page state)
mcp chrome-devtools take_snapshot

# Click elements by uid from snapshot
mcp chrome-devtools click uid="<uid>"

# Fill form fields
mcp chrome-devtools fill uid="<uid>" value="WB-MR6CU"

# Type into focused input (for search/autocomplete)
mcp chrome-devtools type_text text="WB-MR6CU"
```

### Taking screenshots

```
# Viewport screenshot
mcp chrome-devtools take_screenshot filePath="screenshot.png"

# Full page screenshot (includes below-the-fold content)
mcp chrome-devtools take_screenshot filePath="screenshot.png" fullPage=true

# Screenshot of specific element
mcp chrome-devtools take_screenshot uid="<uid>" filePath="element.png"
```

Always use `Read` tool on the saved PNG to visually inspect it.

### Testing mobile / responsive layout

Use `emulate` to set viewport dimensions:

```
# Mobile (iPhone-like)
mcp chrome-devtools emulate viewport={"width":375,"height":812,"isMobile":true,"hasTouch":true,"deviceScaleFactor":1}

# Tablet
mcp chrome-devtools emulate viewport={"width":768,"height":1024,"isMobile":false,"hasTouch":false,"deviceScaleFactor":1}

# Reset to default
mcp chrome-devtools emulate viewport=null
```

**Important**: Changing viewport may cause React state changes (e.g., device tab
deselects). After changing viewport, re-take the snapshot and re-click elements
as needed rather than assuming previous element uids are still valid.

### Testing different parts of the app

**Empty state**: Navigate fresh (clear localStorage first via `evaluate_script`
if needed). The empty state message should be visible.

**Device list and tabs**: Use "Add device" to add devices. Select a
device type (e.g., WB-MR6CU) via the dropdown, click "Add". The device appears
in the sidebar. Click the device tab to load its settings.

**Configuration tabs**: After loading a device, the inner settings tabs appear
(Outputs, Safety Mode, Delays, etc.). Click each tab to verify its content
renders correctly. On mobile, tabs should wrap horizontally above the content.

**Runtime View tab**: Click "Runtime View" tab. Shows Auto-refresh toggle and
Refresh button. Without a serial port, it will show a port error.

**Header buttons**: Verify all buttons (Add device, Select port, Scan,
Save) are visible and not clipped at all viewport sizes.

### Checking computed styles via JavaScript

```
mcp chrome-devtools evaluate_script function="() => {
  const el = document.querySelector('.deviceSettingsWasm-container');
  const cs = getComputedStyle(el);
  return { flexDirection: cs.flexDirection, gap: cs.gap };
}"
```

## Method 2: Host Chrome via CDP (real hardware testing)

Use the host Chrome for testing with actual USB serial devices — scanning for
devices, reading register values, runtime view with live data.

### Prerequisites

1. Host Chrome running: `./run-chromium-sandbox.sh` (on the host, not in VM)
2. USB serial devices connected to host (`/dev/ttyACM*`)
3. Python `websockets` package: `pip install websockets`

### Connecting

From the VM, the host Chrome CDP endpoint is at `192.168.5.2:9223`
(`host.lima.internal:9223`). Always set `Host: localhost` header.

```bash
# Verify Chrome is running
curl -s -H "Host: localhost" http://192.168.5.2:9223/json/version

# List open pages
curl -s -H "Host: localhost" http://192.168.5.2:9223/json/list
```

### Serial port access

Serial ports are auto-granted by Chrome enterprise policy
(`SerialAllowAllPortsForUrls`) for these origins only:

- `http://localhost:3000`
- `http://localhost:5173`

The Vite dev server (`:5173`) and production build (`:3000`) both work.
Other ports require adding the origin to `run-chromium-sandbox.sh`.

### CDP helper scripts

Two Python scripts in `wasm/` automate common verification tasks:

#### `cdp-verify.py` — Full UI verification

Navigates to `http://localhost:3000/`, waits for the app to load, then:
1. Checks empty state visibility
2. Takes desktop (1200x800) and mobile (375x812) screenshots
3. Verifies mobile CSS (`flex-direction`, `flex-wrap`)
4. Clicks "Scan" and waits 20s for device discovery
5. Takes post-scan screenshots at both viewports
6. Checks mobile layout after scan

```bash
cd wasm && python3 cdp-verify.py
# Screenshots saved to wasm/screenshots/
```

#### `cdp-check-css.py` — Quick CSS verification

Checks that CSS media queries are active at 375px viewport:
- Counts `<style>` tags
- Finds media query rules mentioning `deviceSettingsWasm`
- Verifies `window.innerWidth`, `matchMedia`, computed `flex-direction`

```bash
cd wasm && python3 cdp-check-css.py
```

### Writing custom CDP checks

Pattern for one-off CDP verification from the agent:

```python
#!/usr/bin/env python3
import asyncio, json, base64, urllib.request

CDP_HOST = "192.168.5.2"
CDP_PORT = 9223

async def main():
    import websockets

    # Get WebSocket URL for first page
    req = urllib.request.Request(
        f"http://{CDP_HOST}:{CDP_PORT}/json/list",
        headers={"Host": "localhost"},
    )
    pages = json.loads(urllib.request.urlopen(req).read())
    ws_url = pages[0]["webSocketDebuggerUrl"].replace(
        "ws://localhost", f"ws://{CDP_HOST}:{CDP_PORT}"
    )

    msg_id = 0
    def next_id():
        nonlocal msg_id; msg_id += 1; return msg_id

    async with websockets.connect(
        ws_url, additional_headers={"Host": "localhost"}
    ) as ws:

        async def send_cmd(method, params=None):
            cmd_id = next_id()
            msg = {"id": cmd_id, "method": method}
            if params:
                msg["params"] = params
            await ws.send(json.dumps(msg))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == cmd_id:
                    return resp

        async def js(expression):
            r = await send_cmd("Runtime.evaluate", {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            })
            return r.get("result", {}).get("result", {}).get("value")

        async def screenshot(name, width, height):
            await send_cmd("Emulation.setDeviceMetricsOverride", {
                "width": width, "height": height,
                "deviceScaleFactor": 1, "mobile": width <= 768,
            })
            await asyncio.sleep(1.5)
            r = await send_cmd("Page.captureScreenshot", {"format": "png"})
            data = base64.b64decode(r["result"]["data"])
            with open(f"{name}.png", "wb") as f:
                f.write(data)

        await send_cmd("Page.enable")
        await send_cmd("Runtime.enable")

        # Your verification code here...

asyncio.run(main())
```

## Screenshot quality requirements

**Screenshots for PRs must show real, working hardware data.** Specifically:

- Devices must be discovered via Scan (not manually added)
- Device settings must show values read from registers (not defaults)
- Runtime View must show live channel values (not "Port IO error")
- "Error loading current settings from device" is **not acceptable** in PR
  screenshots — it means the serial port was not connected

If USB serial devices are not available, **ask the user** to plug them in
rather than taking screenshots with error states.

Screenshots with manually added devices (showing defaults/errors) are acceptable
only for testing layout and CSS — never for PR screenshots demonstrating
functionality.

## E2E tests (automated)

Playwright E2E tests run against a built version served by TestServer on
port 3210. They use mock data (no real hardware needed).

```bash
cd wasm
npm run build                    # Build first
npx playwright test              # Run all tests
npx playwright test e2e/responsive.spec.ts  # Run specific test
```

Test files:
- `e2e/responsive.spec.ts` — mobile layout (viewport 375x812)
- `e2e/empty-state.spec.ts` — empty state visibility
- `e2e/slave-id-validation.spec.ts` — form validation
- `e2e/runtime-view.spec.ts` — runtime view functionality
- `e2e/sw-offline.spec.ts` — service worker offline mode
- `e2e/sw-slow-network.spec.ts` — service worker slow network
- `e2e/sw-update.spec.ts` — service worker update notification
