# Testing with real USB hardware

This project can be tested against real USB serial devices (Wiren Board modules)
using a sandboxed headless Chrome with WebSerial API.

See also [AGENT-TESTING.md](AGENT-TESTING.md) for the full agent testing guide:
MCP chrome-devtools usage, CDP scripts, screenshot workflows, mobile layout
testing, and screenshot quality requirements for PRs.

## Architecture

The development environment runs inside a Lima VM. USB serial devices
(`/dev/ttyACM*`) are attached to the **host** machine. The sandboxed Chrome
runs on the host with access to those devices, while the dev server runs
inside the VM. Lima automatically forwards ports between host and VM.

```
┌─────────────────────────────────────────┐
│  Host machine                           │
│                                         │
│  /dev/ttyACM0,1,2  ← USB devices       │
│                                         │
│  run-chromium-sandbox.sh                │
│    └─ Chrome (headless, bwrap sandbox)  │
│       CDP on 127.0.0.1:9223            │
│                                         │
│  Lima VM  ◄── port forwarding ──►       │
│  ┌─────────────────────────────────┐    │
│  │  Dev server (vite) :5173        │    │
│  │  Claude Code agent              │    │
│  │    └─ connects to CDP via       │    │
│  │       host.lima.internal:9223   │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

## Step-by-step setup

### 1. Start the sandboxed browser (on host)

Ask the user to run on the **host** machine (not inside the VM):

```bash
./run-chromium-sandbox.sh
```

Prerequisites on the host:
- Google Chrome or Chromium (non-snap): `sudo apt install google-chrome-stable`
- Bubblewrap: `sudo apt install bubblewrap`
- USB serial devices connected (`/dev/ttyACM*`)
- User in `dialout` group for serial port access

The script:
- Runs Chrome headless (`--headless=new`) inside a bubblewrap sandbox
- Blocks `file://` URLs via Chrome enterprise policy
- Auto-grants WebSerial access to whitelisted origins via `SerialAllowAllPortsForUrls`
- Exposes only `/dev/ttyACM*` devices (minimal `/dev`)
- Listens for CDP connections on `127.0.0.1:9223`

### 2. Start the dev server (in VM)

```bash
cd wasm && npm run dev
```

This starts Vite on port 5173. Lima forwards this port to the host,
so Chrome on the host can reach `http://localhost:5173`.

### 3. Connect to Chrome via CDP (from VM)

**Do NOT use the MCP `chrome-devtools` tools** for this. Those tools control a
Chromium instance running inside the VM itself, which has no access to the
host's USB serial devices. Instead, connect directly to the host Chrome's CDP
endpoint using WebSocket calls as shown below.

Chrome's remote debugging is on `127.0.0.1:9223` on the host.
From inside the Lima VM, reach it via `host.lima.internal:9223`
(resolves to `192.168.5.2`).

**Important**: Chrome rejects requests with non-localhost `Host` headers.
Always override the Host header:

```bash
# Check Chrome is running
curl -s -H "Host: localhost" http://192.168.5.2:9223/json/version

# List pages
curl -s -H "Host: localhost" http://192.168.5.2:9223/json/list
```

For WebSocket connections (CDP protocol), pass `Host: localhost` as an extra header:

```python
import websockets
uri = 'ws://192.168.5.2:9223/devtools/page/<PAGE_ID>'
async with websockets.connect(uri, additional_headers={'Host': 'localhost'}) as ws:
    ...
```

### 4. Navigate and use WebSerial

Navigate Chrome to the dev server and call `getPorts()`:

```python
# Navigate
await ws.send(json.dumps({
    'id': 1,
    'method': 'Page.navigate',
    'params': {'url': 'http://localhost:5173/'}
}))

# Get serial ports (policy auto-grants all ports, no user gesture needed)
await ws.send(json.dumps({
    'id': 2,
    'method': 'Runtime.evaluate',
    'params': {
        'expression': '(async () => { const ports = await navigator.serial.getPorts(); return JSON.stringify(ports.map(p => p.getInfo())); })()',
        'awaitPromise': True,
        'returnByValue': True
    }
}))
```

USB serial devices will have `usbVendorId` and `usbProductId` in their info.
Non-USB ports (ttyS*) will have empty info `{}`.

## Whitelisted origins

The `SerialAllowAllPortsForUrls` policy in `run-chromium-sandbox.sh` only
grants serial access to specific origins. Currently whitelisted:

- `http://localhost:3000`
- `http://localhost:5173`
- `http://127.0.0.1:3000`
- `http://127.0.0.1:5173`

Wildcard patterns like `http://localhost:*` do **not** work for this policy.
To use a different port, add the explicit origin to the policy in the script.

## Sandbox details

The bubblewrap sandbox provides:

| Resource | Access | Notes |
|----------|--------|-------|
| Filesystem `/` | read-only | Full host FS visible but not writable |
| `/home` | tmpfs | Empty, no access to user files |
| `/tmp` | tmpfs | Fresh temp directory |
| `/dev` | minimal | Only null, zero, random, urandom, tty + ttyACM* |
| `/sys` | read-only | Needed for USB device enumeration (libudev) |
| `/run/udev` | read-only | Needed for device metadata (vid/pid) |
| `/dev/shm` | tmpfs | Chrome shared memory |
| `file://` URLs | blocked | Via Chrome enterprise URLBlocklist policy |
| Network | full | Same as host (needed for localhost dev server) |
