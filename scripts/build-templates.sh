#!/bin/bash

STABLE_DIR=submodule/wb-mqtt-serial-stable/templates
TESTING_DIR=submodule/wb-mqtt-serial/templates
TEMPLATES_DIR=wasm/assets/templates

prepare()
{
    local SRC_DIR=$1
    local DST_DIR=$2

    mkdir -p $DST_DIR

    cp $SRC_DIR/config-map*.json $DST_DIR
    cp $SRC_DIR/config-wb-*.json $DST_DIR

    for FILE in $SRC_DIR/config-map*.json.jinja $SRC_DIR/config-wb-*.json.jinja; do
        j2 -o $DST_DIR/$(basename $FILE .jinja) $FILE
    done
}

prepare $STABLE_DIR $TEMPLATES_DIR/stable
prepare $TESTING_DIR $TEMPLATES_DIR/testing

mkdir -p $TEMPLATES_DIR/common

for FILE in $TEMPLATES_DIR/stable/*; do
    OTHER=$TEMPLATES_DIR/testing/$(basename $FILE)
    if [ -f $OTHER ] && cmp -s $FILE $OTHER; then
        mv $FILE $TEMPLATES_DIR/common/
        rm $OTHER
    fi
done

for FILE in $TEMPLATES_DIR/*/*.json; do
    grep -v '^[[:space:]]*//' $FILE | jq -c . > $FILE.min && mv $FILE.min $FILE
done
