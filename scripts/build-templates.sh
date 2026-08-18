#!/bin/bash

set -e

STABLE_BRANCH=$1
TESTING_BRANCH=$2
TEMPLATES_DIR=$3

URL=https://github.com/wirenboard/wb-mqtt-serial.git
FETCH_DIR=$(mktemp -d)

trap "rm -rf $FETCH_DIR" EXIT
git init --bare --quiet $FETCH_DIR/repo.git

fetch()
{
    local BRANCH=$1
    local DST_DIR=$2

    mkdir -p $DST_DIR

    git -C $FETCH_DIR/repo.git fetch --quiet --depth 1 $URL $BRANCH
    git -C $FETCH_DIR/repo.git archive FETCH_HEAD templates | tar -x -C $DST_DIR --strip-components 1

    echo "$BRANCH: $(git -C $FETCH_DIR/repo.git rev-parse --short FETCH_HEAD), $(ls $DST_DIR | wc -l) templates"
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
