#!/bin/bash
# Launch Chromium/Chrome in a headless sandbox with:
# - Temporary home directory (wiped on exit)
# - file:// URLs blocked via per-instance policy
# - WebSerial API enabled (headless=new, Chrome 144+)
# - Minimal /dev (only standard devices + ttyACM*)
# - Read-only /sys for device enumeration
# - Remote debugging on port 9223 (for DevTools/MCP)
#
# Usage: ./run-chromium-sandbox.sh
#   Navigate to desired URLs via CDP (remote debugging port 9223).
#
# Requires: bubblewrap (sudo apt install bubblewrap)

set -euo pipefail

# Find a non-snap Chromium or Chrome binary
find_browser() {
    local candidates=(
        chromium
        chromium-browser
        google-chrome-stable
        google-chrome
    )
    for cmd in "${candidates[@]}"; do
        local path
        path=$(command -v "$cmd" 2>/dev/null) || continue
        # Skip snap-installed browsers (check both the path and symlink target)
        if [[ "$path" == */snap/* ]] || [[ "$(readlink "$path" 2>/dev/null)" == */snap/* ]]; then
            continue
        fi
        echo "$path"
        return
    done
    echo "Error: no non-snap Chromium or Chrome found" >&2
    echo "Install one with: sudo apt install chromium" >&2
    exit 1
}

BROWSER=$(find_browser)
echo "Using browser: $BROWSER"

POLICYDIR=$(mktemp -d)
trap 'rm -rf "$POLICYDIR"' EXIT

# Policy: block file:// URLs, auto-grant WebSerial access
# SerialAllowAllPortsForUrls: auto-grant all serial ports for listed origins
# Note: wildcard ports (http://localhost:*) don't work — list explicit origins
POLICY='{
  "URLBlocklist": ["file://*"],
  "DefaultSerialGuardSetting": 1,
  "SerialAllowAllPortsForUrls": ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]
}'

# Create policy dir for both Chromium (/etc/chromium) and Chrome (/etc/opt/chrome)
mkdir -p "$POLICYDIR/policies/managed"
echo "$POLICY" > "$POLICYDIR/policies/managed/sandbox-policy.json"

# Copy existing chromium config if present
if [ -f /etc/chromium/master_preferences ]; then
    cp /etc/chromium/master_preferences "$POLICYDIR/"
fi

# Build --dev-bind args for available ttyACM devices
DEV_ARGS=()
for dev in /dev/ttyACM*; do
    [ -c "$dev" ] && DEV_ARGS+=(--dev-bind "$dev" "$dev")
done
if [ ${#DEV_ARGS[@]} -eq 0 ]; then
    echo "Warning: no /dev/ttyACM* devices found" >&2
fi

exec bwrap \
    --ro-bind / / \
    --tmpfs /home \
    --tmpfs /tmp \
    --dev /dev \
    --tmpfs /dev/shm \
    "${DEV_ARGS[@]}" \
    --proc /proc \
    --ro-bind /sys /sys \
    --ro-bind /run/udev /run/udev \
    --bind "$POLICYDIR" /etc/chromium \
    --tmpfs /etc/opt \
    --bind "$POLICYDIR" /etc/opt/chrome \
    "$BROWSER" --no-first-run --no-sandbox --disable-gpu-sandbox \
    --disable-setuid-sandbox --headless=new --enable-features=WebSerial \
    --user-data-dir=/tmp/chrome-profile \
    --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1
