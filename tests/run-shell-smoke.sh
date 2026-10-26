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
# A stand-in Joplin launcher, so the menu shows the Open Joplin button. The
# script never really starts it.
mkdir -p "$XDG_DATA_HOME/applications"
printf '[Desktop Entry]\nType=Application\nName=Joplin\nExec=true\n' > "$XDG_DATA_HOME/applications/joplin.desktop"

# Without a Joplin to talk to, start the fake one (needs Node).
FAKE_PID=
if [ -z "${SMOKE_JOPLIN_URL:-}" ] && command -v node > /dev/null; then
    port_file=$SANDBOX/fake-port
    node "$REPO/tests/helpers/fakeJoplinServer.js" --port 0 --token test-token > "$port_file" &
    FAKE_PID=$!
    for _ in $(seq 100); do
        grep -q LISTENING "$port_file" && break
        sleep 0.1
    done
    export SMOKE_JOPLIN_URL="http://127.0.0.1:$(awk '/LISTENING/ {print $2}' "$port_file")"
    export SMOKE_JOPLIN_TOKEN=test-token SMOKE_JOPLIN_FAKE=1
fi
trap '[ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2> /dev/null || true' EXIT

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

# Errors and criticals up to the shell's own teardown. One whose stack trace
# lies entirely inside GNOME Shell (in this bare environment, e.g. the dash
# missing app icons) is listed but doesn't fail the run; one that involves the
# extension or the script, or has no stack trace at all, does.
if ! awk '
    function report() {
        if (frames == 0 || ours) {
            print "  ERROR: " block
            failed = 1
        } else {
            print "  (GNOME Shell, not the extension) " block
        }
        block = ""
    }
    /Shutting down GNOME Shell/ { exit }
    /JS ERROR|CRITICAL|Script failed|Extension failed/ {
        if (block != "") report()
        block = $0; frames = 0; ours = 0
        next
    }
    block != "" && /^[ \t]*(Stack trace:)?[ \t]*$/ { next }
    block != "" && /^[ \t]*[^ ]*@(resource|file):\/\// {
        block = block "\n    " $0
        frames++
        if ($0 ~ /todo-list@theblackprism\.ch|smoke\.js/)
            ours = 1
        next
    }
    block != "" { report() }
    END {
        if (block != "")
            report()
        exit failed
    }' "$log"; then
    echo "Errors in $log" >&2
    [ "$status" -eq 0 ] && status=1
fi
grep -E 'JS WARNING|Gjs-Console-WARNING' "$log" | grep -E 'todo|To-do' || true
echo "Log and screenshots: $SMOKE_OUTPUT"
exit "$status"
