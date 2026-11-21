# Pyodide feasibility for `wb-mqtt-dali` in the browser

**Verdict: feasible, no blockers found.** The whole daemon tree — `wb.mqtt_dali.gateway`,
`commissioning`, `wbdali`, all of `python-dali` including `dali.tests.fakes` — imports and
runs under Pyodide, fully offline, in Node and in a real headless Chrome (module Web Worker
*and* main thread), with **8 small stub modules** and one deliberately trimmed dependency set.

Everything below is measured, not estimated. PoC: `pyodide-poc/` (`node run-poc.mjs`).

---

## 1. Versions and what has to ship

| | |
| --- | --- |
| `pyodide` npm | **314.0.6** (pinned; the new scheme tracks the CPython version) |
| CPython | **3.14.2** |
| ABI / platform | `2026_0` / `emscripten_5_0_3` `wasm32` |
| packages in `pyodide-lock.json` | 356 |

Files a browser actually needs (the npm package also ships `.d.ts`, `.map`, `console.html`
— none of that is shipped):

| file | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| `pyodide.mjs` (loader) | 0.02 MiB | 0.01 | 0.01 |
| `pyodide.asm.mjs` (emscripten glue) | 1.19 MiB | 0.25 | 0.20 |
| `pyodide.asm.wasm` | **9.15 MiB** | 3.43 | 2.61 |
| `python_stdlib.zip` | **2.43 MiB** | 2.39 | 2.37 |
| `wbdali-all.tar.gz` (daemon + deps + stubs) | 0.50 MiB | — | — |
| `wbdali-data.tar.gz` (`products.csv` + schemas) | 0.18 MiB | — | — |
| **total** | **13.47 MiB** | **6.75 MiB** | **5.86 MiB** |

`pyodide-lock.json` (112 KiB) is only needed if you call `loadPackage`; we inline it as
`lockFileContents` and never fetch it.

The 0.50 MiB python payload breaks down as **231 KiB** our sources (`wb/` 747 KiB,
`dali/` 297 KiB, `mqttrpc/` 18 KiB, `jsonrpc/` 52 KiB, `paho` 2.8 KiB, stubs 10 KiB
uncompressed = 137 files / 1.10 MiB) and **278 KiB** third-party wheels.

---

## 2. Packaging: how the pure-Python code gets in, offline

Measured in four *fresh* interpreters with `fetch()` hard-blocked (`node bench-packaging.mjs`):

| method | shipped bytes | install | notes |
| --- | ---: | ---: | --- |
| **`unpackArchive(tar.gz)`** | **512 KiB** | 211 ms | smallest payload — best for base64 inlining |
| `unpackArchive(zip)` | 599 KiB | **57 ms** | 4× faster install, +87 KiB |
| `FS.writeFile` per file | 2302 KiB (496 KiB if you gzip the blob yourself) | 30 ms | fastest, but you hand-roll the container and ship 255 separate blobs |
| `micropip.install("emfs:/…whl")` | 541 KiB + 113 KiB for the `micropip` wheel itself | 472 ms | slowest, largest, and only handles wheels — our own sources still need `unpackArchive` |

**Recommendation: one `unpackArchive(bytes, "tar.gz")` call with a single merged archive**
(`wbdali-all.tar.gz` = the jsonschema wheels pre-unzipped + our sources + stubs). It needs no
`micropip`, no network, no lockfile, and one round trip. Switch to `.zip` only if the 150 ms
matters more than 87 KiB.

Two things this proved that were not obvious:

* **Wheels can be installed by just unzipping them into `site-packages`.** That includes
  `rpds_py`, a *native* wasm extension — Pyodide's import hook `dlopen`s the `.so` lazily, so
  `micropip` is not required for binary wheels either. (`node poc-offline-boot.mjs`)
* **In Node, `unpackArchive` rejects a `Buffer`** with `RuntimeError: Unknown typed array type
  'Buffer'`. Wrap it: `new Uint8Array(fs.readFileSync(...))`.

### Optional: ship precompiled bytecode

Running `compileall` inside Pyodide and re-packing gives `wbdali-all-pyc.tar.gz`:

| | bundle | unpack | import all 9 targets |
| --- | ---: | ---: | ---: |
| sources only | 512 KiB | 211 ms | **1015 ms** |
| sources + `.pyc` | 1380 KiB | 288 ms | **479 ms** |

−536 ms of import time for +868 KiB (+1.16 MiB as base64). Worth it if startup latency
matters; do the `compileall` at build time, in a Pyodide of the *exact same* CPython version.

---

## 3. Third-party dependencies

### `jsonschema` — bundled, and `draft4_format_checker` still exists

Pyodide 314.0.6 ships **jsonschema 4.26.0**. Verified in-interpreter:

```
version                       4.26.0
draft4_format_checker         present (FormatChecker)  -> emits DeprecationWarning
Draft4Validator               present
validate(..., format_checker) works (rejects a bad "ipv4")
```

So `main.py:119` and `common_dali_device.py:812` (`format_checker=jsonschema.draft4_format_checker`)
run **as-is today**. It is deprecated ("use the `FORMAT_CHECKER` attribute on the corresponding
Validator") and will disappear — pin the wheel, and plan a one-line change to
`jsonschema.Draft4Validator.FORMAT_CHECKER`.

Dependency chain actually needed: `attrs`, `referencing`, `rpds-py` (native), `jsonschema-specifications`,
`typing-extensions`. The Pyodide lock *also* lists `pyrsistent` and `six` for jsonschema — stale
metadata; 4.26 never imports them. Excluding them is verified-safe and saves 69 KiB.

### `jsonrpc` (PyPI `json-rpc` 1.13.0)

Pure Python, **not** in the Pyodide lock. Vendored from the PyPI wheel minus `tests/` and
`backend/` (its Django/Flask adapters). 10 files, 52 KiB.

### `paho.mqtt.matcher` — vendor 3 files, not the package

`MQTTMatcher` is the only thing `MQTTDispatcher` uses, and `paho/mqtt/matcher.py` **has zero
imports** — it is a self-contained prefix trie. `paho/mqtt/__init__.py` is 4 lines
(`__version__` + `MQTTException`); `paho/__init__.py` is empty. Vendoring just those three
files costs **2.8 KiB** instead of a 67 KiB wheel, and pulls in no sockets, no threads, no
`ssl`. Confirmed: nothing in `wb/` touches `paho.mqtt.client`.

`mqttrpc` ships `client.py`, the only file that imports `paho.mqtt.client` and `threading`.
`mqttrpc/__init__.py` does not import it, so the bundle simply drops that file.

### Stub inventory

All under `pyodide-poc/stubs/`, 10 KiB total. Names were derived by grepping the vendored `wb/` tree.

| stub | referenced by | what it provides |
| --- | --- | --- |
| `aiomqtt.py` | `wbmqtt`, `mqtt_dispatcher`, `mqtt_rpc_{client,server}`, `wbdali`, `dali2_*`, `device_publisher`, `application_controller`, `main` | `Client` (`__aenter__/__aexit__`, `publish`, `subscribe`, `unsubscribe`, `.messages` async generator, plus a `deliver()` hook so JS can inject messages), `Message` (`.topic/.payload/.retain`), `Topic` (`.value`, `.matches`), `Will`, `MqttError`, `MqttCodeError`, `ProtocolVersion`, `TLSParameters`. Loopback-only: `publish()` feeds `.messages`, which is enough to run the daemon against itself. |
| `websockets/{__init__,exceptions,http11,typing}.py`, `websockets/asyncio/server.py` | `fake_lunatone_iot` (imported by `gateway`) | `exceptions.ConnectionClosed{,OK,Error}`, `http11.Request/Response/Headers`, `typing.Data`, `asyncio.server.ServerConnection`/`Server`/`serve`. `serve()` **raises** if used — a browser tab cannot listen on TCP. Importing is enough; construct the gateway with `websocket_enabled=False`. |
| `systemd/journal.py` | `main.py` (guarded `try: from systemd.journal import JournalHandler`) | `JournalHandler` as a plain `StreamHandler`. |
| `wb_common/mqtt_client.py` | `main.py` | `DEFAULT_BROKER_URL` only. |

`dali/driver` was already stripped from the vendored tree; `dali/tests/fakes_serial.py` is the
only remaining file that imports it and the bundle excludes it (along with the `test_*.py`
pytest suites). `dali/tests/fakes.py` — the in-memory bus — imports nothing outside `dali` and
the stdlib, and is kept.

### Import results (Node, cold, in order)

```
OK  dali.command                   17.5 ms
OK  dali.gear.general              30.7 ms
OK  dali.device.general            30.7 ms
OK  dali.sequences                  1.0 ms
OK  dali.tests.fakes               26.1 ms
OK  wb.mqtt_dali.wbdali            66.3 ms
OK  wb.mqtt_dali.commissioning    616.4 ms   <- pulls in application_controller,
OK  wb.mqtt_dali.gateway          172.1 ms      common_dali_device, all dali_type*_parameters
OK  wb.mqtt_dali.main              93.0 ms
```

~1.05 s for the whole tree from source, ~0.48 s with precompiled `.pyc`. `main.py` imports
cleanly too (thanks to the `wb_common` + `systemd` stubs), it just cannot be *called* — see §6.

Beyond imports, `py/test_daemon.py` exercises real objects and all of it passes:
`MQTTDispatcher` wildcard + exact dispatch, its retained-message replay, a full `MQTTRPCServer`
round trip (result / `JSONRPCServerError` / `MethodNotFound`) over the stub broker,
`dali.tests.fakes.Bus` (`DAPC`→254, `Off`→0) and `run_sequence(QueryDeviceTypes)`,
`DaliDatabase` loading all **8778 products** from the 743 KiB `products.csv` in the wasm FS,
`jsonschema.validate` against the shipped config schema, `build_command_registry()` →
**372 commands**, and `WbDaliGateway(...)` construction.

---

## 4. asyncio under Pyodide's WebLoop

`asyncio.get_running_loop()` returns `pyodide.webloop.WebLoop`. Every primitive the daemon
uses works (`node run-poc.mjs`, `py/test_asyncio.py`):

| primitive | result |
| --- | --- |
| `asyncio.Queue` | FIFO, `QueueEmpty`, `join()`/`task_done()`, `maxsize` backpressure — all correct |
| `asyncio.Lock` | 3 concurrent workers serialised correctly |
| `asyncio.Future` | result, `set_exception`, `cancel()` → `CancelledError` |
| `loop.call_later` / `call_soon` | fire in order; `handle.cancel()` works |
| `asyncio.wait_for` | `TimeoutError` at 51 ms for a 50 ms timeout; pass-through fine |
| `asyncio.create_task` (+ `name=`) | fine; `cancel()` propagates, `task.cancelled()` True |
| `asyncio.gather(return_exceptions=True)` | correct, incl. propagation without the flag and nesting |
| `asyncio.Event`, `asyncio.wait`, `asyncio.shield` | correct |
| **async generators** (`async for message in client.messages`) | correct, incl. `__anext__` and `aclose()` |
| combined queue+lock+future+`call_later`+gather RPC round trip | correct |

### Deviations to know about

1. **`loop.call_later()` returns `asyncio.events.Handle`, not `asyncio.TimerHandle`.**
   Harmless here — `application_controller.py:422` only *annotates* `Optional[asyncio.TimerHandle]`
   — but any `isinstance(h, asyncio.TimerHandle)` would silently fail.
2. **`loop.run_forever()` is a no-op that returns immediately** instead of blocking. Code that
   uses it to stay alive falls straight through.
3. **`loop.add_signal_handler()` raises `NotImplementedError`** ("no POSIX signals"). `main.py`
   calls it in two places (lines 92-93 and 307-308) — needs a guard or a browser-specific entry point.
4. **`asyncio.to_thread()` *works*** (an executor exists). Don't be fooled: there is still one
   wasm thread, so a genuinely blocking callable will block everything. Treat it as unavailable.
5. `asyncio.create_subprocess_exec` raises `NotImplementedError`, as expected.

### `asyncio.run` / `run_until_complete` — it depends on JSPI

This is the one place where Node and Chrome disagree, and the answer is the opposite of the
usual folklore:

* **Node 22:** both raise `RuntimeError: WebAssembly stack switching not supported in this JavaScript runtime`.
* **Chrome 151 (headless, verified):** `pyodide.ffi.run_sync` is present, and **both
  `asyncio.run()` and `loop.run_until_complete()` work** — Pyodide's `enableRunUntilComplete`
  defaults to `true` and uses JSPI stack switching.

JSPI shipped in Chrome/Edge 137; Firefox and Safari do not have it. **Do not depend on it.**

### The right driving pattern from JS

The WebLoop *is* already running — it is the JS event loop. So:

```js
// 1. start long-lived work, do not block
await pyodide.runPythonAsync(`
    import asyncio, wb.mqtt_dali.gateway as gw
    task = asyncio.create_task(dispatcher.run())   # keep a reference!
`);
// 2. push events in from JS (WebSerial, MQTT-over-WebSocket, UI)
pyodide.globals.get("mqtt_client").deliver(msg);
// 3. call into python and await the coroutine as a JS promise
const reply = await pyodide.runPythonAsync(`await gateway.handle_rpc(payload)`);
```

`runPythonAsync` compiles with top-level `await` and returns a JS promise — that is the bridge.
Never call `asyncio.run()`/`run_until_complete()` in shared code, never `loop.run_forever()`,
and keep a strong reference to every `create_task()` result (an unreferenced task can be GC'd).

---

## 5. Boot time and memory

Node 22 (`node run-poc.mjs`), sources only, network hard-blocked after `loadPyodide`:

| phase | time |
| --- | ---: |
| cold `loadPyodide()` | **1952 ms** |
| `unpackArchive` daemon bundle | 237 ms |
| `unpackArchive` data bundle | 9 ms |
| import the full `wb.mqtt_dali.gateway` tree (9 modules) | **1015 ms** |
| **total to a usable daemon** | **~3.2 s** |

Fully in-memory boot (`node poc-offline-boot.mjs`, gzip+base64 strings, no fs, no network):
decode 50 ms + boot 1892 ms + unpack 229 ms + import 1109 ms = **3.28 s**.

Real headless Chrome 151 (`vite-demo`, module Web Worker): `loadPyodide` 2086 ms,
unpack 189 ms, imports 970 ms — **3.36 s** wall clock from navigation to a ready daemon.
Single-file build from `file://` on the main thread: **3.85 s**.

Memory:

| | |
| --- | --- |
| wasm heap after boot | **30 MiB** |
| wasm heap after importing everything | **36 MiB** (same in Node and Chrome) |
| Node RSS, whole process | 177 MiB |
| Chrome JS heap (main-thread build, includes the 10 MiB inlined HTML strings) | 87 MiB |
| `sys.modules` | 445 (79 `wb.*`, 29 `dali*`) |

36 MiB of wasm heap for the interpreter + the whole daemon is the number that matters; it does
not grow with imports after that.

---

## 6. Vite: Web Worker, normal build, and the single-file offline build

`pyodide-poc/vite-demo/` is a working reference for both builds, verified in headless Chrome.

### Web Worker

Run Pyodide in a **module** worker (`{ type: "module" }` / `worker.format: "es"`). Pyodide
*throws* in a classic worker ("Classic web workers are not supported"). Pass
`createPyodideModule` (a static `import` of `pyodide/pyodide.asm.mjs`) so nothing is loaded via
dynamic `import()` at runtime — that is what makes the worker (and a service worker) work and
lets Vite bundle the 1.19 MiB glue as ordinary JS.

Serve Pyodide's two byte assets from memory with a `fetch()` shim on a sentinel origin:

```js
const ORIGIN = "https://pyodide.invalid/";
self.fetch = async (input, init) => VIRTUAL[String(input)] ?? realFetch(input, init);
await loadPyodide({ indexURL: ORIGIN, lockFileContents, packageBaseUrl: ORIGIN, createPyodideModule });
```

This is cleaner than overriding `Module.instantiateWasm` (which forces you to reproduce
Pyodide's private JSPI error-marker imports) and behaves identically online and offline.
No COOP/COEP headers and no `SharedArrayBuffer` are required.

### Four Vite gotchas, all hit and fixed in the demo

1. **Vite emits a second copy of the 9.6 MB wasm.** `pyodide.asm.mjs` contains
   `new URL("pyodide.asm.wasm", import.meta.url).href` inside `findWasmBinary()`. That branch is
   dead (Pyodide always sets `Module.locateFile`) but Vite still sees the pattern. In a
   single-file build, with `assetsInlineLimit: Infinity`, it becomes a **+12.8 MiB base64 data
   URI**. A 6-line `transform` plugin rewriting it to a plain string fixes it.
2. **Worker bundles get their own plugin pipeline.** Main-config plugins are not applied — the
   strip plugin must also be registered under `worker.plugins`.
3. **`?url` assets get base64-inlined by `vite-plugin-singlefile`**, and if the importer is an
   *inline* worker they are encoded **twice** (1.78×). Alias the module that holds the `?url`
   imports to a stub in the offline build. Skipping steps 1–3 produced a **38.29 MiB**
   `index.html`; with them it is **10.46 MiB**.
4. **An inline (`blob:`) worker loses the page's base URL.** Vite's root-relative
   `/assets/x-hash.wasm` cannot be resolved inside it. Pass `document.baseURI` in the boot message.

### Is inlining ~10 MB of wasm as base64 viable? Yes — with one caveat

The demo's `OFFLINE=1` build is a **single 10.46 MiB `index.html`**:

| | |
| --- | --- |
| index.html on disk | **10.46 MiB** (base64 payload 8.74 MiB + 1.72 MiB inlined JS) |
| served with gzip | 6.94 MiB |
| served with brotli | **6.66 MiB** |
| separate brotli-compressed assets, for comparison | 5.86 MiB |

So base64 inlining costs **~0.8 MiB over the wire** once the server compresses — base64 of
already-gzipped bytes recompresses back down almost perfectly. On disk it is 10.5 MiB, which
is the number that matters for "save the page to a USB stick". Decoding all of it (`atob` +
`DecompressionStream('gzip')`) takes **~50 ms**. This is the same technique
`wasm/vite-plugin-offline-embed.ts` already uses for `module.wasm`/`module.data`, so it fits
the existing app: gzip+base64 into `<script type="application/gzip+base64" id="...">` blocks,
decompress in a tiny loader, hand the bytes to the consumer.

**The caveat — and it is the one real surprise:** a single-file page opened from `file://`
**cannot use a Web Worker at all**. Chrome refuses the blob-URL module worker with *"Refused to
cross-origin redirects of the top-level worker script"*, and once everything is inlined there
is no other URL to load the worker from. Verified. The demo detects
`location.protocol === "file:"` and runs the identical boot routine on the **main thread**,
which works (3.85 s, 36 MiB heap) but blocks the UI while Python executes.

Practical shape for the app:

* **normal build** — Pyodide in a module Web Worker, assets as ordinary hashed files (13.9 MiB
  in `dist/`, 5.9 MiB brotli), cached by the existing service worker.
* **offline single-file build** — inline everything, main thread. +10.5 MiB on top of the
  current offline HTML. Since Python work is bursty (a commissioning scan, an RPC call),
  main-thread execution is tolerable, but long DALI sequences will freeze the UI; chunk them
  with `await asyncio.sleep(0)` if that shows up.
* **the alternative you asked about** — lazy-load Pyodide from a CDN when online and declare
  DALI unavailable offline — is *not* necessary. It saves 10.5 MiB from the offline file but
  breaks exactly the scenario the offline build exists for. A middle option, if 10.5 MiB is too
  much: keep the offline HTML DALI-free and ship a **second** self-contained `dali.html`
  (~10.5 MiB) alongside it, so the main offline tool stays small.

---

## 7. Blockers, risks and follow-ups

Nothing blocks the PoC. Ordered by how much work they imply:

1. **No entry point for the browser.** `main.py` imports fine but calls `loop.add_signal_handler`
   (raises) and drives everything from `asyncio.run`. A browser entry point has to construct the
   `Gateway` directly and let JS drive the loop (§4).
2. **MQTT is a stub.** `stubs/aiomqtt.py` is loopback-only. Real operation needs either an
   MQTT-over-WebSocket client on the JS side wired into `Client.deliver()`/`publish()`, or a
   purely in-page broker. The stub's shape (`.messages` async generator + `deliver()`) is
   designed for exactly that bridge.
3. **No DALI transport.** `dali/driver` is stripped. A WebSerial-backed driver has to be written
   on the JS side and exposed to Python; `dali.tests.fakes.Bus` is a working stand-in until then
   (and it is in the bundle).
4. **`fake_lunatone_iot` cannot serve.** `gateway.py` imports it unconditionally; construct with
   `websocket_enabled=False` or the stubbed `serve()` raises.
5. **`schemas/common_device.schema.json` is missing from the vendored tree.** `common_dali_device.py:697`
   opens `/usr/share/wb-mqtt-dali/schemas/common_device.schema.json` at runtime. It exists upstream
   (`/tmp/wb-mqtt-dali/schemas/`); `build-bundle.mjs` falls back to the upstream checkout and warns
   if neither is present. Should be vendored.
6. **`jsonschema.draft4_format_checker` is deprecated.** Works in 4.26.0; pin the wheel and plan
   the switch to `Draft4Validator.FORMAT_CHECKER`.
7. **Wheel ABI is tied to the exact Pyodide build** (`2026_0`). `rpds_py` and any other native
   wheel must be re-fetched from the matching CDN version on every Pyodide upgrade —
   `fetch-deps.mjs` reads the version from the installed package, so this is one command.
8. **Persistence.** `gateway.save_configuration()` writes via `tempfile` + `os.fdopen` + rename
   into MEMFS: it works, but is lost on reload. Needs an IDBFS mount or a JS-side store.
9. **`enableRunUntilComplete` / JSPI divergence** between Chrome and Node/Firefox/Safari (§4).
   Keep it out of shared code so tests in Node stay representative.

---

## Reproducing

```bash
cd pyodide-poc && npm install
node run-poc.mjs            # -> ALL CHECKS PASSED
node bench-packaging.mjs    # packaging comparison table
node poc-offline-boot.mjs   # boot from base64 only

cd vite-demo && npm install
npx vite build && OFFLINE=1 npx vite build
google-chrome --headless=new --no-sandbox --remote-debugging-port=9333 \
  --user-data-dir=/tmp/chrome-poc about:blank &
npx vite preview &
node ../browser-check.mjs http://127.0.0.1:4173/ 9333
node ../browser-check.mjs "file://$PWD/dist-offline/index.html" 9333
```
