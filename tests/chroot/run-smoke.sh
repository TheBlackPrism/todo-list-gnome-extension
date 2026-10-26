#!/usr/bin/env bash
# Runs tests/run-shell-smoke.sh inside a chroot made by setup-*.sh, as an
# unprivileged user. Screenshots are copied to OUTPUT (default ./build/smoke-<root>).
# With JOPLIN_URL and JOPLIN_TOKEN set the shell syncs with that Joplin.
# Usage: sudo tests/chroot/run-smoke.sh ROOT [OUTPUT]
set -euo pipefail
. "$(dirname "$0")/common.sh"

ROOT=${1:?usage: run-smoke.sh ROOT [OUTPUT]}
OUTPUT=${2:-$REPO_DIR/build/smoke-$(basename "$ROOT")}
INSIDE=/tmp/smoke-output

# The chroot has no Node: run the fake Joplin here unless a real one is given.
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
start_system_bus "$ROOT"
rm -rf "$ROOT$INSIDE"
mkdir -p "$ROOT$INSIDE"
in_chroot "$ROOT" chown tester "$INSIDE"
in_chroot "$ROOT" gnome-shell --version

status=0
in_chroot "$ROOT" runuser -u tester -- env SMOKE_OUTPUT="$INSIDE" SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-300}" \
    SMOKE_JOPLIN_URL="$JOPLIN_URL" SMOKE_JOPLIN_TOKEN="$JOPLIN_TOKEN" \
    SMOKE_JOPLIN_FAKE="${JOPLIN_FAKE:-}" \
    /work/tests/run-shell-smoke.sh || status=$?

mkdir -p "$OUTPUT"
cp -r "$ROOT$INSIDE/." "$OUTPUT/"
echo "Copied to $OUTPUT"
exit "$status"
