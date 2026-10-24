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

mount_chroot "$ROOT"
start_system_bus "$ROOT"
rm -rf "$ROOT$INSIDE"
mkdir -p "$ROOT$INSIDE"
in_chroot "$ROOT" chown tester "$INSIDE"
in_chroot "$ROOT" gnome-shell --version

status=0
in_chroot "$ROOT" runuser -u tester -- env SMOKE_OUTPUT="$INSIDE" SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-300}" \
    SMOKE_JOPLIN_URL="${JOPLIN_URL:-}" SMOKE_JOPLIN_TOKEN="${JOPLIN_TOKEN:-}" \
    /work/tests/run-shell-smoke.sh || status=$?

mkdir -p "$OUTPUT"
cp -r "$ROOT$INSIDE/." "$OUTPUT/"
echo "Copied to $OUTPUT"
exit "$status"
