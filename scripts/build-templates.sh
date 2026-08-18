#!/bin/bash

set -e

STABLE_BRANCH=$1
TESTING_BRANCH=$2
TEMPLATES_DIR=$3

URL=https://github.com/wirenboard/wb-mqtt-serial/archive/refs/heads
FETCH_DIR=$(mktemp -d)

trap "rm -rf $FETCH_DIR" EXIT

fetch()
{
    local BRANCH=$1
    local DST_DIR=$2

    mkdir -p $DST_DIR
    curl -sfL $URL/$BRANCH.tar.gz | tar -xz -C $DST_DIR --strip-components 2 --wildcards --no-wildcards-match-slash '*/templates/*'

    echo "$BRANCH: $(ls $DST_DIR | wc -l) templates"
}

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

fetch $STABLE_BRANCH $FETCH_DIR/stable
fetch $TESTING_BRANCH $FETCH_DIR/testing

rm -rf $TEMPLATES_DIR

prepare $FETCH_DIR/stable $TEMPLATES_DIR/stable
prepare $FETCH_DIR/testing $TEMPLATES_DIR/testing

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
