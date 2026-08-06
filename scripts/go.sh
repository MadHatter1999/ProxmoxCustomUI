#!/usr/bin/env bash
#
# go.sh - the one-shot. Run this and nothing else on a fresh Proxmox node:
# it finds+mounts the kit USB, installs what it needs, and joins the cluster.
#
set -uo pipefail

echo "==> Proxbox node join - locating the kit USB"

# 1. Is the kit already reachable (this script's own dir, or an existing mount)?
KIT=""
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
for p in "$here" /mnt/usb/proxbox-join /run/media/*/proxbox-join /media/*/proxbox-join; do
  [[ -f "$p/join-proxbox-node.sh" ]] && KIT="$p" && break
done

# 2. Not mounted yet - mount it ourselves. Try the known label first, then scan
#    ONLY FAT/exFAT partitions (USB sticks) so we never touch the node's disks.
if [[ -z "$KIT" ]]; then
  mkdir -p /mnt/usb
  mount -L ROCKY-BOOKW /mnt/usb 2>/dev/null || true
  if [[ ! -f /mnt/usb/proxbox-join/join-proxbox-node.sh ]]; then
    while read -r dev; do
      umount /mnt/usb 2>/dev/null || true
      mount "$dev" /mnt/usb 2>/dev/null || continue
      [[ -f /mnt/usb/proxbox-join/join-proxbox-node.sh ]] && break
      umount /mnt/usb 2>/dev/null || true
    done < <(lsblk -pnro NAME,FSTYPE | awk '$2=="exfat" || $2=="vfat"{print $1}')
  fi
  KIT=/mnt/usb/proxbox-join
fi
[[ -f "$KIT/join-proxbox-node.sh" ]] || {
  echo "Couldn't find the proxbox-join kit on any USB. Is the stick plugged in?"; exit 1; }
echo "==> kit: $KIT"

# 3. Install the two tools the joiner needs. A fresh node's enterprise apt repo
#    401s without a subscription, so try a direct install first (the Debian
#    index is usually already there) and only add the free repo as a fallback.
for pkg in jq sshpass; do
  command -v "$pkg" >/dev/null 2>&1 && continue
  echo "==> installing $pkg"
  apt-get install -y "$pkg" >/dev/null 2>&1 && continue
  echo 'deb http://download.proxmox.com/debian/pve trixie pve-no-subscription' \
    > /etc/apt/sources.list.d/pve-no-sub.list
  apt-get update && apt-get install -y "$pkg" \
    || { echo "Couldn't install $pkg - check the node's internet/apt."; exit 1; }
done

# 4. Hand off to the joiner (which does all the real work + verification).
echo "==> starting the join"
exec bash "$KIT/join-proxbox-node.sh"
