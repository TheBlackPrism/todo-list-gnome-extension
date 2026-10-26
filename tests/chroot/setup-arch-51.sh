#!/usr/bin/env bash
# Builds an Arch Linux chroot with the current GNOME Shell (51 at the time of writing)
# for the smoke test.
# Usage: sudo tests/chroot/setup-arch-51.sh [ROOT]   (default /srv/gnome51)
set -euo pipefail
. "$(dirname "$0")/common.sh"

ROOT=${1:-/srv/gnome51}
MIRROR=${MIRROR:-https://geo.mirror.pkgbuild.com}

if [ ! -x "$ROOT/usr/bin/pacman" ]; then
    mkdir -p "$ROOT"
    curl -fsSL "$MIRROR/iso/latest/archlinux-bootstrap-x86_64.tar.zst" |
        tar --zstd -x -C "$ROOT" --strip-components=1
fi

mount_chroot "$ROOT"
echo "Server = $MIRROR/\$repo/os/\$arch" > "$ROOT/etc/pacman.d/mirrorlist"
# pacman's download sandbox and free-space check both need things a plain chroot
# lacks (the root isn't a mount point).
grep -q '^DisableSandbox' "$ROOT/etc/pacman.conf" ||
    sed -i 's/^\[options\]/[options]\nDisableSandbox/' "$ROOT/etc/pacman.conf"
sed -i 's/^CheckSpace/#CheckSpace/' "$ROOT/etc/pacman.conf"
if [ -r "$PROXY_CA" ]; then
    cp "$PROXY_CA" "$ROOT/etc/ca-certificates/trust-source/anchors/agent-proxy.crt"
    in_chroot "$ROOT" update-ca-trust
fi

in_chroot "$ROOT" pacman-key --init
in_chroot "$ROOT" pacman-key --populate archlinux
in_chroot "$ROOT" pacman -Syu --noconfirm --needed \
    gnome-shell gjs libsoup3 xorg-xwayland glib2 make zip unzip
add_test_user "$ROOT"
in_chroot "$ROOT" gnome-shell --version
