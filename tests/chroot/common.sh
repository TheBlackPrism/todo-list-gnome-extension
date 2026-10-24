#!/usr/bin/env bash
# Helpers shared by the chroot scripts. They build throwaway distro roots that
# run a real, headless GNOME Shell for the smoke tests. Root only.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROXY_CA=/root/.ccr/ca-bundle.crt

# mount_chroot ROOT: bind the kernel filesystems and the repository (read-only, at /work).
mount_chroot() {
    local root=$1
    local dir
    for dir in proc sys dev dev/pts dev/shm; do
        mkdir -p "$root/$dir"
        mountpoint -q "$root/$dir" || mount --bind "/$dir" "$root/$dir"
    done
    mkdir -p "$root/work"
    if ! mountpoint -q "$root/work"; then
        mount --bind "$REPO_DIR" "$root/work"
        mount -o remount,bind,ro "$root/work"
    fi
    cp -L /etc/resolv.conf "$root/etc/resolv.conf"
}

umount_chroot() {
    local root=$1
    local dir
    for dir in work dev/shm dev/pts dev sys proc; do
        mountpoint -q "$root/$dir" && umount -l "$root/$dir"
    done
    return 0
}

# in_chroot ROOT CMD...: run a command inside the chroot, keeping the proxy settings.
in_chroot() {
    local root=$1
    shift
    chroot "$root" /usr/bin/env -i \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/root LANG=C.UTF-8 TERM="${TERM:-dumb}" \
        https_proxy="${https_proxy:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" \
        no_proxy="${no_proxy:-}" NO_PROXY="${NO_PROXY:-}" \
        "$@"
}

# add_test_user ROOT: an unprivileged user, so the shell doesn't warn about root.
add_test_user() {
    local root=$1
    in_chroot "$root" sh -c 'id tester >/dev/null 2>&1 || useradd -m -s /bin/sh tester'
}
