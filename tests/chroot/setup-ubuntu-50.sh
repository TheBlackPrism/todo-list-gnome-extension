#!/usr/bin/env bash
# Builds an Ubuntu 26.04 chroot with GNOME Shell 50 for the smoke test.
# Usage: sudo tests/chroot/setup-ubuntu-50.sh [ROOT]   (default /srv/gnome50)
set -euo pipefail
. "$(dirname "$0")/common.sh"

ROOT=${1:-/srv/gnome50}
MIRROR=${MIRROR:-http://archive.ubuntu.com/ubuntu}

if [ ! -x "$ROOT/usr/bin/apt-get" ]; then
    script=/usr/share/debootstrap/scripts/resolute
    [ -e "$script" ] || script=/usr/share/debootstrap/scripts/gutsy
    debootstrap --variant=minbase --components=main,universe \
        resolute "$ROOT" "$MIRROR" "$script"
fi

mount_chroot "$ROOT"
cat > "$ROOT/etc/apt/sources.list" <<SOURCES
deb $MIRROR resolute main universe
deb $MIRROR resolute-updates main universe
SOURCES
if [ -r "$PROXY_CA" ]; then
    mkdir -p "$ROOT/usr/local/share/ca-certificates"
    cp "$PROXY_CA" "$ROOT/usr/local/share/ca-certificates/agent-proxy.crt"
fi

in_chroot "$ROOT" apt-get update
in_chroot "$ROOT" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates gnome-shell gjs gir1.2-soup-3.0 xwayland dbus dbus-bin \
    libglib2.0-bin make zip unzip \
    libgtk-4-1 gir1.2-gtk-4.0 gir1.2-adw-1
in_chroot "$ROOT" update-ca-certificates
add_test_user "$ROOT"
in_chroot "$ROOT" gnome-shell --version
