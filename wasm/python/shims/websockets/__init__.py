"""Stub for `websockets`.

Reached only through `wb.mqtt_dali.fake_lunatone_iot`, which `gateway.py`
imports at module level for the Lunatone DALI Cockpit bridge. A browser tab
cannot listen for inbound connections, so the feature is unavailable; the
import must still succeed, and `serve()` fails loudly if anything ever enables
it (`websocket_enabled` in the gateway config, off by default).
"""
