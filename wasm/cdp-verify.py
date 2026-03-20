#!/usr/bin/env python3
"""Drive host Chrome via CDP to verify UI on real hardware."""
import asyncio
import json
import base64
import os
import urllib.request

CDP_HOST = "192.168.5.2"
CDP_PORT = 9223
APP_URL = "http://localhost:3000/"
SDIR = "/home/boger/work/board/wb-wasm-device-editor/wasm/screenshots"

os.makedirs(SDIR, exist_ok=True)

# Get the current page
PAGE_ID = None  # Will be obtained from list


async def main():
    import websockets

    import urllib.request as urlreq
    req = urlreq.Request(
        f"http://{CDP_HOST}:{CDP_PORT}/json/list",
        headers={"Host": "localhost"},
    )
    pages = json.loads(urlreq.urlopen(req).read())
    ws_url = pages[0]["webSocketDebuggerUrl"].replace(
        "ws://localhost", f"ws://{CDP_HOST}:{CDP_PORT}"
    )

    msg_id = 0

    def next_id():
        nonlocal msg_id
        msg_id += 1
        return msg_id

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
            r = await send_cmd(
                "Runtime.evaluate",
                {"expression": expression, "awaitPromise": True, "returnByValue": True},
            )
            return r.get("result", {}).get("result", {}).get("value")

        async def screenshot(name, width, height):
            await send_cmd("Emulation.setDeviceMetricsOverride", {
                "width": width, "height": height,
                "deviceScaleFactor": 1, "mobile": width <= 768,
            })
            await asyncio.sleep(1.5)
            r = await send_cmd("Page.captureScreenshot", {"format": "png"})
            data = base64.b64decode(r["result"]["data"])
            path = f"{SDIR}/{name}.png"
            with open(path, "wb") as f:
                f.write(data)
            print(f"  {name}.png ({len(data)} bytes)")

        await send_cmd("Page.enable")
        await send_cmd("Runtime.enable")

        # Navigate fresh — no service worker, no cache on this new tab
        await send_cmd("Page.navigate", {"url": APP_URL})

        # Wait for app ready
        for i in range(25):
            await asyncio.sleep(2)
            ready = await js(
                'Array.from(document.querySelectorAll("button"))'
                '.some(b => b.textContent.includes("Add device"))'
            )
            if ready:
                print(f"App ready after {(i+1)*2}s")
                break
        else:
            print("WARNING: App not ready")
            await screenshot("debug-not-ready", 1200, 800)
            return

        # Verify we're using the built version (not Vite dev)
        css = await js(
            'JSON.stringify(Array.from(document.querySelectorAll("link[rel=stylesheet]")).map(l => l.href))'
        )
        has_vite = await js('!!document.querySelector("script[src*=vite]")')
        print(f"CSS links: {css}")
        print(f"Has Vite client: {has_vite}")

        # ─── Empty state ───
        print("\n=== Empty state ===")
        has_empty = await js('!!document.querySelector(".deviceSettingsWasm-emptyState")')
        print(f"Visible: {has_empty}")
        if has_empty:
            text = await js('document.querySelector(".deviceSettingsWasm-emptyState").textContent')
            print(f"Text: {text}")

        await screenshot("01-desktop-empty-state", 1200, 800)
        await screenshot("02-mobile-empty-state", 375, 812)

        # ─── Mobile layout ───
        print("\n=== Mobile layout ===")
        await send_cmd("Emulation.setDeviceMetricsOverride", {
            "width": 375, "height": 812, "deviceScaleFactor": 1, "mobile": True
        })
        await asyncio.sleep(1)

        flex_dir = await js(
            'getComputedStyle(document.querySelector(".deviceSettingsWasm-container")).flexDirection'
        )
        wrap = await js(
            'getComputedStyle(document.querySelector(".page-actions")).flexWrap'
        )
        print(f"flex-direction: {flex_dir}, flex-wrap: {wrap}")

        btns = await js(
            'JSON.stringify(Array.from(document.querySelectorAll(".page-actions button"))'
            '.map(b => ({t: b.textContent.trim(), r: Math.round(b.getBoundingClientRect().right)})))'
        )
        print(f"Buttons: {btns}")

        # ─── Scan ───
        print("\n=== Scan ===")
        await send_cmd("Emulation.clearDeviceMetricsOverride")
        await asyncio.sleep(0.5)

        await js(
            'Array.from(document.querySelectorAll("button"))'
            '.find(b => b.textContent.trim() === "Scan").click()'
        )
        print("Scanning...")
        await asyncio.sleep(20)

        count = await js('document.querySelectorAll("[role=tab]").length')
        print(f"Devices: {count}")

        await screenshot("03-desktop-after-scan", 1200, 800)
        await screenshot("04-mobile-after-scan", 375, 812)

        # ─── Mobile after scan ───
        print("\n=== Mobile after scan ===")
        await send_cmd("Emulation.setDeviceMetricsOverride", {
            "width": 375, "height": 812, "deviceScaleFactor": 1, "mobile": True
        })
        await asyncio.sleep(1)
        fd = await js(
            'getComputedStyle(document.querySelector(".deviceSettingsWasm-container")).flexDirection'
        )
        ox = await js(
            'getComputedStyle(document.querySelector(".deviceSettingsWasm-content")).overflowX'
        )
        print(f"flex-direction: {fd}, overflow-x: {ox}")

        await send_cmd("Emulation.clearDeviceMetricsOverride")
        print("\nDone!")


asyncio.run(main())
