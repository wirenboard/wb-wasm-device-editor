#!/bin/bash
# Fetch the pure-Python sources that run inside Pyodide.
#
# Everything landed in $DST is a verbatim copy of an upstream package; nothing
# here is edited. Browser-specific adaptation lives in wasm/python/runtime and
# wasm/python/shims, which are versioned in this repository.
#
# Mirrors scripts/build-templates.sh: fetch over HTTPS from pinned refs, no
# submodule and no package manager needed at build time.

set -e

DST=${1:-wasm/python/vendor}

# soft-dali-host-apis carries the simulator, the gateway link, the memo and the
# host seams (wirenboard/wb-mqtt-dali#226, #227, #228); back to main once merged.
WB_MQTT_DALI_REF=${WB_MQTT_DALI_REF:-soft-dali-host-apis}
PYTHON_DALI_REF=${PYTHON_DALI_REF:-dev/v0.11}
PYTHON_MQTT_RPC_REF=${PYTHON_MQTT_RPC_REF:-main}
JSON_RPC_REF=${JSON_RPC_REF:-master}
PAHO_MQTT_REF=${PAHO_MQTT_REF:-master}

FETCH_DIR=$(mktemp -d)
trap "rm -rf $FETCH_DIR" EXIT

fetch()
{
    local REPO=$1
    local REF=$2
    local NAME=$3

    local ARCHIVE=$FETCH_DIR/$NAME.tar.gz
    local ATTEMPT

    mkdir -p $FETCH_DIR/$NAME
    for ATTEMPT in 1 2 3; do
        if curl -sfL --retry 3 --retry-all-errors -o $ARCHIVE \
            "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz"; then
            break
        fi
        [ $ATTEMPT -eq 3 ] && { echo "failed to fetch $REPO@$REF" >&2; exit 1; }
        sleep 2
    done
    tar -xzf $ARCHIVE -C $FETCH_DIR/$NAME --strip-components 1
    echo "$REPO@$REF -> $FETCH_DIR/$NAME"
}

fetch wirenboard/wb-mqtt-dali        "$WB_MQTT_DALI_REF"    wb-mqtt-dali
fetch wirenboard/python-dali         "$PYTHON_DALI_REF"     python-dali
fetch wirenboard/python-mqtt-rpc     "$PYTHON_MQTT_RPC_REF" python-mqtt-rpc
fetch pavlov99/json-rpc            "$JSON_RPC_REF"        json-rpc
fetch eclipse-paho/paho.mqtt.python  "$PAHO_MQTT_REF"       paho-mqtt

rm -rf $DST
mkdir -p $DST

# wb-mqtt-dali: the package plus the data files the daemon reads at runtime
cp -r $FETCH_DIR/wb-mqtt-dali/wb $DST/
cp $FETCH_DIR/wb-mqtt-dali/wb-mqtt-dali.schema.json $DST/
cp $FETCH_DIR/wb-mqtt-dali/products.csv $DST/
cp -r $FETCH_DIR/wb-mqtt-dali/schemas $DST/

# python-dali: the DALI protocol library. dali/tests/fakes.py is the model of
# real control gear the bus simulator drives, so the tests package is kept.
cp -r $FETCH_DIR/python-dali/dali $DST/
rm -rf $DST/dali/driver          # serial/usb/hid backends, unusable in a browser

# mqttrpc: only the JSON-RPC-over-MQTT protocol classes are used
cp -r $FETCH_DIR/python-mqtt-rpc/mqttrpc $DST/

# jsonrpc: the JSON-RPC 1.0/2.0 request/response objects mqttrpc builds on
cp -r $FETCH_DIR/json-rpc/jsonrpc $DST/

# paho: MQTTDispatcher's only use of paho-mqtt is the topic-filter trie, which
# is a standalone dependency-free module. The rest of paho is a network client
# we have no use for in a browser.
mkdir -p $DST/paho/mqtt
: > $DST/paho/__init__.py
: > $DST/paho/mqtt/__init__.py
cp $FETCH_DIR/paho-mqtt/src/paho/mqtt/matcher.py $DST/paho/mqtt/

# Strip bytecode and caches so the bundle stays small and reproducible
find $DST -name '__pycache__' -type d -prune -exec rm -rf {} +
find $DST -name '*.pyc' -delete

echo "python sources in $DST: $(du -sh $DST | cut -f1)"
