#!/usr/bin/env bash
# Starts a real, headless GNOME Shell (50 or later) with the extension
# installed into throwaway directories, drives it with tests/shell/smoke.js,
# and fails on any JavaScript error. It never touches your own to-dos or
# settings. Screenshots go to $SMOKE_OUTPUT (default: a new temporary directory).
#
#   SMOKE_JOPLIN_URL=http://127.0.0.1:41184 SMOKE_JOPLIN_TOKEN=... tests/run-shell-smoke.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)

SANDBOX=$(mktemp -d)
export HOME=$SANDBOX/home
export XDG_DATA_HOME=$SANDBOX/data XDG_CONFIG_HOME=$SANDBOX/config XDG_CACHE_HOME=$SANDBOX/cache
export XDG_RUNTIME_DIR=$SANDBOX/runtime
mkdir -p "$HOME" "$XDG_DATA_HOME/gnome-shell" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
mkdir -m 700 "$XDG_RUNTIME_DIR"
# Skips the one-time "screen lock disabled" notification of headless sessions.
touch "$XDG_DATA_HOME/gnome-shell/lock-warning-shown"

export SMOKE_OUTPUT=${SMOKE_OUTPUT:-$SANDBOX/screenshots}
mkdir -p "$SMOKE_OUTPUT"
make -s -C "$REPO" install BUILD_DIR="$SANDBOX/build" > /dev/null

export NO_AT_BRIDGE=1 GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1
# --force-animations as in GNOME Shell's own test runner: without the startup
# animation the shell can finish starting before the script module has loaded,
# and the script then never runs.
log=$SMOKE_OUTPUT/shell.log
status=0
timeout "${SMOKE_TIMEOUT:-300}" dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800 --no-x11 --force-animations \
    --automation-script "${SMOKE_SCRIPT:-$REPO/tests/shell/smoke.js}" > "$log" 2>&1 || status=$?

grep -E 'smoke: ' "$log" | sed 's/^.*smoke: /  /' || true
# GNOME Shell's own teardown after the script logs criticals; only check
# what happened before it.
if sed '/Shutting down GNOME Shell/q' "$log" |
    grep -E 'JS ERROR|CRITICAL|Script failed|Extension failed'; then
    echo "Errors in $log" >&2
    [ "$status" -eq 0 ] && status=1
fi
grep -E 'JS WARNING|Gjs-Console-WARNING' "$log" | grep -E 'todo|To-do' || true
echo "Log and screenshots: $SMOKE_OUTPUT"
exit "$status"
