#!/usr/bin/env bash
# Runs the GJS tests (needs gjs, libsoup 3 and glib-compile-schemas).
# With JOPLIN_URL and JOPLIN_TOKEN set they run against that Joplin;
# otherwise a fake Joplin server is started (needs Node).
set -euo pipefail
cd "$(dirname "$0")/.."

SCHEMA_DIR=$(mktemp -d)
FAKE_PID=
cleanup() {
    [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
    rm -rf "$SCHEMA_DIR"
}
trap cleanup EXIT

glib-compile-schemas --strict --targetdir="$SCHEMA_DIR" src/schemas
export SCHEMA_DIR GSETTINGS_BACKEND=memory

if [ -z "${JOPLIN_URL:-}" ]; then
    export JOPLIN_TOKEN=test-token JOPLIN_FAKE=1
    port_file=$(mktemp)
    node tests/helpers/fakeJoplinServer.js --port 0 --token "$JOPLIN_TOKEN" > "$port_file" &
    FAKE_PID=$!
    for _ in $(seq 100); do
        grep -q LISTENING "$port_file" && break
        sleep 0.1
    done
    export JOPLIN_URL="http://127.0.0.1:$(awk '/LISTENING/ {print $2}' "$port_file")"
    rm -f "$port_file"
fi

gjs -m tests/gjs/stack.test.js
