#!/usr/bin/env bash
# Runs the GJS tests inside a chroot made by setup-*.sh, against the fake Joplin
# server (started here, on the host) or, with JOPLIN_URL and JOPLIN_TOKEN set,
# against a real Joplin. The chroot shares the host's loopback.
# Usage: sudo tests/chroot/run-gjs.sh ROOT
set -euo pipefail
. "$(dirname "$0")/common.sh"

ROOT=${1:?usage: run-gjs.sh ROOT}
FAKE_PID=
cleanup() {
    [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true
}
trap cleanup EXIT

if [ -z "${JOPLIN_URL:-}" ]; then
    port_file=$(mktemp)
    node "$REPO_DIR/tests/helpers/fakeJoplinServer.js" --port 0 --token test-token > "$port_file" &
    FAKE_PID=$!
    for _ in $(seq 100); do
        grep -q LISTENING "$port_file" && break
        sleep 0.1
    done
    JOPLIN_URL="http://127.0.0.1:$(awk '/LISTENING/ {print $2}' "$port_file")"
    JOPLIN_TOKEN=test-token
    JOPLIN_FAKE=1
    rm -f "$port_file"
fi

mount_chroot "$ROOT"
in_chroot "$ROOT" gnome-shell --version
in_chroot "$ROOT" runuser -u tester -- env HOME=/home/tester \
    JOPLIN_URL="$JOPLIN_URL" JOPLIN_TOKEN="$JOPLIN_TOKEN" JOPLIN_FAKE="${JOPLIN_FAKE:-}" \
    /work/tests/run-gjs.sh
