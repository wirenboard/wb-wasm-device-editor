# Project: wb-wasm-device-editor

## Testing with real hardware

See [AGENTS.md](AGENTS.md) for instructions on testing with real USB serial
devices (Wiren Board modules) via sandboxed headless Chrome and WebSerial API.

Key points:
- The sandboxed browser runs on the **host** machine (not in the VM)
- Connect to Chrome DevTools Protocol at `host.lima.internal:9223` with `Host: localhost` header
- Dev server runs in the VM on port 5173 (`cd wasm && npm run dev`)
- Use `navigator.serial.getPorts()` — ports are auto-granted by policy, no user gesture needed
