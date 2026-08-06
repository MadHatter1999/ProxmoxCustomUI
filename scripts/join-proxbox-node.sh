#!/usr/bin/env bash
#
# join-proxbox-node.sh
# ---------------------
# Run this ON A FRESHLY-INSTALLED Proxmox VE node to fold it into the existing
# "pb-cluster" and make it usable by The Proxbox - end to end, hands-off.
#
# What it does, in order:
#   1. Sanity-checks the box (root, real Proxmox, fresh, right subnet, unique name).
#   2. Writes /etc/hosts so every node - old and new - resolves by name.
#   3. Joins the corosync cluster (the "master list" every node shares).
#   4. Teaches the existing nodes this new box's name->IP (best effort).
#   5. Verifies the cluster is quorate, the node is online, and its `local`
#      storage is active and images-capable - which is all the Proxbox needs to
#      start placing machines here (it auto-discovers nodes from the API).
#
# The Proxbox app itself needs NO changes: it reads /cluster/resources through
# pve1's API, so a node that's in the cluster shows up on its own.
#
# Usage:
#   scp this file to the new node, then:
#     chmod +x join-proxbox-node.sh
#     ./join-proxbox-node.sh
#
#   The node's hostname IS its cluster name - set it correctly during the
#   Proxmox install (e.g. pve5). Renaming a node after it joins is painful, so
#   this script refuses to join under a generic or duplicate name.
#
set -euo pipefail

# ------------------------------------------------------------------ config ----
# The cluster is described in nodes.json, which rides ALONG with this script
# (same directory). It's the single source of truth for the node list - and
# this script APPENDS the new node to it after a successful join, so the file
# grows itself. Keep that updated nodes.json for the next node you add.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CONFIG="${NODES_JSON:-$SCRIPT_DIR/nodes.json}"

# --------------------------------------------------------------- utilities ----
c_red=$'\e[31m'; c_grn=$'\e[32m'; c_yel=$'\e[33m'; c_cyn=$'\e[36m'; c_rst=$'\e[0m'
say()  { echo "${c_cyn}==>${c_rst} $*"; }
ok()   { echo "${c_grn} ok${c_rst} $*"; }
warn() { echo "${c_yel}  !${c_rst} $*"; }
die()  { echo "${c_red}FAILED:${c_rst} $*" >&2; exit 1; }

# Install a package if it's missing. A freshly-installed Proxmox node points apt
# at the ENTERPRISE repo, which 401s without a subscription and makes a plain
# 'apt-get update' exit non-zero - but the Debian package indexes are still
# usable, so we try a direct install first and only update as a fallback.
ensure_pkg() {
  command -v "$1" >/dev/null 2>&1 && return 0
  say "installing $1"
  apt-get install -y -qq "$1" >/dev/null 2>&1 && return 0
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq "$1" >/dev/null 2>&1 \
    || die "couldn't install '$1'. Set up the Proxmox no-subscription (or a Debian) apt repo, then re-run.
     Quick fix on the node:
       apt-get install -y $1        # often just works (Debian index already present)
     If that says 'Unable to locate package', add the no-subscription repo first."
}

# ------------------------------------------------------------- 0. sanity  ----
[[ $EUID -eq 0 ]] || die "run as root."
command -v pvecm    >/dev/null || die "this isn't a Proxmox node (no pvecm). Install Proxmox VE first."
command -v pvesm    >/dev/null || die "pvesm missing - not a healthy Proxmox install."

# ---------------------------------------------------- load nodes.json ----
[[ -f "$CONFIG" ]] || die "node list not found at '$CONFIG'. Keep nodes.json next to this script (or set NODES_JSON=/path)."
ensure_pkg jq
jq empty "$CONFIG" 2>/dev/null || die "'$CONFIG' isn't valid JSON."

CLUSTER="$(jq -r '.cluster // empty' "$CONFIG")"
DOMAIN="$(jq -r '.domain // "lab.local"' "$CONFIG")"
SUBNET_PREFIX="$(jq -r '.subnet_prefix // empty' "$CONFIG")"
[[ -n "$CLUSTER" && -n "$SUBNET_PREFIX" ]] || die "'$CONFIG' must set at least .cluster and .subnet_prefix."

declare -A NODES=()
while IFS=$'\t' read -r _name _ip; do
  [[ -n "$_name" ]] && NODES["$_name"]="$_ip"
done < <(jq -r '.nodes | to_entries[] | "\(.key)\t\(.value)"' "$CONFIG")
[[ ${#NODES[@]} -gt 0 ]] || die "'$CONFIG' has no nodes listed."

mapfile -t JOIN_ORDER < <(jq -r '(.join_order // (.nodes | keys))[]' "$CONFIG")
say "loaded ${#NODES[@]} known nodes from $(basename "$CONFIG") for cluster '${CLUSTER}'"

SELF_NAME="$(hostname -s)"
# Pick the interface IP that lives on the cluster subnet.
SELF_IP="$(hostname -I | tr ' ' '\n' | grep -E "^${SUBNET_PREFIX//./\\.}" | head -1 || true)"

say "This node reports itself as '${SELF_NAME}' at '${SELF_IP:-<none on ${SUBNET_PREFIX}0>}'"

[[ -n "$SELF_IP" ]] || die "no IP on ${SUBNET_PREFIX}0/24. Give this node a static address on the cluster network first."

# Fresh? A node with guests or an existing cluster cannot join.
if [[ -f /etc/pve/corosync.conf ]]; then
  die "this node is already in a cluster (/etc/pve/corosync.conf exists). Nothing to do."
fi
GUESTS="$( { qm list 2>/dev/null | tail -n +2; pct list 2>/dev/null | tail -n +2; } | wc -l )"
[[ "$GUESTS" -eq 0 ]] || die "this node already has ${GUESTS} VM(s)/CT(s). Joining a cluster wipes local guest config - start from a clean install."

# Name must be real and unique.
case "$SELF_NAME" in
  ''|pve|proxmox|debian|localhost)
    next="pve$(( ${#NODES[@]} + 1 ))"
    die "hostname '${SELF_NAME}' is generic. Set a proper node name (suggested: ${next}) with:
        hostnamectl set-hostname ${next}
     then fix /etc/hosts's 127.0.1.1 line, reboot, and re-run this." ;;
esac
if [[ -n "${NODES[$SELF_NAME]+x}" ]]; then
  die "'${SELF_NAME}' is already a member name in pb-cluster. Pick a new, unique hostname."
fi
for n in "${!NODES[@]}"; do
  [[ "${NODES[$n]}" == "$SELF_IP" ]] && die "IP ${SELF_IP} already belongs to existing node '${n}'. Assign this node a free address."
done

# Find a reachable join target.
JOIN_TARGET_NAME=""; JOIN_TARGET_IP=""
for n in "${JOIN_ORDER[@]}"; do
  ip="${NODES[$n]}"
  if ping -c1 -W2 "$ip" >/dev/null 2>&1; then JOIN_TARGET_NAME="$n"; JOIN_TARGET_IP="$ip"; break; fi
done
[[ -n "$JOIN_TARGET_IP" ]] || die "can't reach ANY existing node (${JOIN_ORDER[*]}). Check the network."
ok "will join via ${JOIN_TARGET_NAME} (${JOIN_TARGET_IP})"

# Version drift is a common corosync headache - warn, don't block.
LOCAL_VER="$(pveversion | sed -E 's#pve-manager/([0-9.]+).*#\1#')"
say "local Proxmox version: ${LOCAL_VER} (target should match closely)"

# ---------------------------------------------------------- 1. /etc/hosts ----
say "wiring /etc/hosts for all nodes + self"
add_host() { # ip  name
  local ip="$1" name="$2"
  if grep -qE "^\s*${ip//./\\.}\s" /etc/hosts; then return; fi
  echo "${ip} ${name}.${DOMAIN} ${name}" >> /etc/hosts
}
add_host "$SELF_IP" "$SELF_NAME"
for n in "${!NODES[@]}"; do add_host "${NODES[$n]}" "$n"; done
ok "/etc/hosts updated"

# ------------------------------------------------------------- 2. confirm ----
echo
echo "About to JOIN this node into ${CLUSTER}:"
echo "    new node : ${SELF_NAME}  (${SELF_IP})"
echo "    join via : ${JOIN_TARGET_NAME}  (${JOIN_TARGET_IP})"
echo "This contacts the cluster and is not trivially reversible."
read -r -p "Type the cluster name '${CLUSTER}' to proceed: " CONFIRM
[[ "$CONFIRM" == "$CLUSTER" ]] || die "not confirmed - nothing changed."

# Establish passwordless SSH trust to the target so pvecm add runs unattended.
# The password is read once, held only in memory, never written to disk.
read -r -s -p "root@${JOIN_TARGET_NAME} password: " ROOT_PW; echo
[[ -n "$ROOT_PW" ]] || die "no password given."

ensure_pkg sshpass

mkdir -p /root/.ssh && chmod 700 /root/.ssh
[[ -f /root/.ssh/id_rsa ]] || ssh-keygen -t rsa -b 2048 -N '' -f /root/.ssh/id_rsa >/dev/null
ssh-keyscan -H "$JOIN_TARGET_IP" >> /root/.ssh/known_hosts 2>/dev/null || true
say "seeding SSH trust to ${JOIN_TARGET_NAME}"
sshpass -p "$ROOT_PW" ssh-copy-id -o StrictHostKeyChecking=accept-new "root@${JOIN_TARGET_IP}" >/dev/null 2>&1 \
  || die "couldn't establish SSH to ${JOIN_TARGET_NAME} - check the password and that root SSH is allowed."
ok "passwordless SSH to ${JOIN_TARGET_NAME} established"

# -------------------------------------------------------------- 3. join   ----
say "joining the cluster (corosync link on ${SELF_IP}) - this takes ~30s"
pvecm add "$JOIN_TARGET_IP" --link0 "$SELF_IP" --use_ssh 1 \
  || die "pvecm add failed. Check corosync/network and 'journalctl -u corosync'."

# Give pmxcfs/corosync a moment to converge.
sleep 5
systemctl is-active --quiet pve-cluster || systemctl restart pve-cluster || true

# ----------------------------------------------- 4. teach the other nodes ----
# corosync already syncs membership cluster-wide; this is just /etc/hosts hygiene
# so admins on the old nodes can resolve the new one by name. Best effort.
say "adding this node to the other members' /etc/hosts (best effort)"
for n in "${!NODES[@]}"; do
  ip="${NODES[$n]}"
  sshpass -p "$ROOT_PW" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "root@${ip}" \
    "grep -qE '^\s*${SELF_IP//./\\.}\s' /etc/hosts || echo '${SELF_IP} ${SELF_NAME}.${DOMAIN} ${SELF_NAME}' >> /etc/hosts" \
    >/dev/null 2>&1 && ok "  ${n}" || warn "  ${n}: couldn't update (non-fatal)"
done

# ------------------------------------------------------------- 5. verify   ----
echo
say "verifying"

pvecm status >/dev/null 2>&1 || die "pvecm status failed after join."
if pvecm status | grep -q 'Quorate:\s*Yes'; then ok "cluster is quorate"; else die "cluster NOT quorate - investigate before trusting this node."; fi

# Is THIS node listed as a member?
if pvecm nodes | awk '{print $3}' | grep -qx "$SELF_NAME"; then
  ok "'${SELF_NAME}' is a cluster member"
else
  die "'${SELF_NAME}' not showing in 'pvecm nodes' yet."
fi

# Record the new node back into nodes.json so the list grows itself, write it
# straight into the file on the (USB) kit, and FLUSH. The earlier version mv'd
# from /tmp and never synced - across an exFAT stick that could silently not
# persist (or a read-only remount), so the join worked but the node went
# unrecorded. Here we overwrite in place, sync, then read it back to prove it.
if tmp="$(mktemp)" \
   && jq --arg n "$SELF_NAME" --arg ip "$SELF_IP" \
        '.nodes[$n] = $ip
         | .join_order = (.join_order // (.nodes | keys))
         | if (.join_order | index($n)) then . else .join_order += [$n] end' \
        "$CONFIG" > "$tmp" 2>/dev/null \
   && jq empty "$tmp" 2>/dev/null \
   && cat "$tmp" > "$CONFIG" 2>/dev/null; then
  sync
  rm -f "$tmp"
  if jq -e --arg n "$SELF_NAME" '.nodes[$n] == $ip' --arg ip "$SELF_IP" "$CONFIG" >/dev/null 2>&1; then
    ok "recorded ${SELF_NAME} (${SELF_IP}) in $(basename "$CONFIG") and flushed to disk"
  else
    warn "wrote $(basename "$CONFIG") but couldn't verify it persisted - if the USB is read-only, remount rw or add \"${SELF_NAME}\": \"${SELF_IP}\" by hand."
  fi
else
  rm -f "$tmp" 2>/dev/null || true
  warn "couldn't update $(basename "$CONFIG") - if the USB is read-only, remount rw or add \"${SELF_NAME}\": \"${SELF_IP}\" to its \"nodes\" by hand."
fi

# The Proxbox places machines on any storage whose content includes 'images'.
# The cluster's `local` storage (no 'nodes' restriction) should now be active
# here automatically. Confirm it, because without it the app can't land a VM.
if pvesm status 2>/dev/null | awk 'NR>1 && $1=="local" && $3=="active"{f=1} END{exit !f}'; then
  ok "'local' storage is active on this node"
else
  warn "'local' storage not active yet - run 'pvesm status'. The Proxbox needs an images-capable, active storage here to place VMs."
fi
# --content images lists only storages the app would consider for placement.
imgs="$(pvesm status --content images 2>/dev/null | awk 'NR>1 && $3=="active"{print $1}' | paste -sd, -)"
if [[ -n "$imgs" ]]; then
  ok "images-capable storage the Proxbox can place onto: ${imgs}"
else
  warn "no active images-capable storage here yet - the Proxbox won't place machines until one is active."
fi

# The decisive check: look at the node through the SAME API and the SAME lens the
# Proxbox uses. The app reads /cluster/resources and treats a node as a real
# placement target when it appears as type=node AND has a storage whose content
# includes 'images' (see src/placement.ts). Prove both from the cluster's API so
# "the UI treats it like the others" isn't an assumption.
say "confirming the Proxbox's own data source (cluster API) sees ${SELF_NAME} like the others"
parity_ok=false
for attempt in 1 2 3 4 5; do
  TJSON="$(curl -sk --max-time 10 \
      --data-urlencode "username=root@pam" --data-urlencode "password=${ROOT_PW}" \
      "https://${JOIN_TARGET_IP}:8006/api2/json/access/ticket" 2>/dev/null || true)"
  TICKET="$(printf '%s' "$TJSON" | jq -r '.data.ticket // empty' 2>/dev/null)"
  if [[ -n "$TICKET" ]]; then
    RJSON="$(curl -sk --max-time 10 -b "PVEAuthCookie=${TICKET}" \
        "https://${JOIN_TARGET_IP}:8006/api2/json/cluster/resources" 2>/dev/null || true)"
    node_seen="$(printf '%s' "$RJSON" | jq -r --arg n "$SELF_NAME" \
        '[.data[]? | select(.type=="node" and .node==$n and .status=="online")] | length' 2>/dev/null)"
    img_seen="$(printf '%s' "$RJSON" | jq -r --arg n "$SELF_NAME" \
        '[.data[]? | select(.type=="storage" and .node==$n and ((.content // "") | test("images")))] | length' 2>/dev/null)"
    if [[ "${node_seen:-0}" -ge 1 && "${img_seen:-0}" -ge 1 ]]; then parity_ok=true; break; fi
  fi
  sleep 5   # pvestatd refreshes cluster/resources every ~10s; give it time
done
if $parity_ok; then
  ok "the Proxbox will treat ${SELF_NAME} exactly like the other nodes (visible as a node + images storage in the API)"
else
  warn "couldn't confirm ${SELF_NAME} in the cluster API yet - it usually appears within ~30s. Recheck the Proxbox in a minute; if it's still missing, run 'pvesm status' and 'pvecm status' here."
fi
unset ROOT_PW

# ------------------------------------------------- 6. eject the kit USB  ----
# We've written nodes.json back to the stick; now unmount + eject it so it's
# safe to pull. This script is itself running FROM the USB, so a plain unmount
# would say "busy" - we background it with a short delay so it fires the instant
# this process exits, and it survives (reparented to init) because we detach it.
KIT_MNT="$(findmnt -no TARGET --target "$CONFIG" 2>/dev/null || true)"
KIT_DEV="$(findmnt -no SOURCE --target "$CONFIG" 2>/dev/null || true)"
if [[ -n "$KIT_MNT" && "$KIT_MNT" != "/" ]]; then
  ( sleep 3; cd /; sync
    umount "$KIT_MNT" 2>/dev/null || umount -l "$KIT_MNT" 2>/dev/null
    command -v eject >/dev/null 2>&1 && [[ -n "$KIT_DEV" ]] && eject "$KIT_DEV" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  ok "USB will unmount & eject in a few seconds - wait for its light, then pull it"
fi

# ------------------------------------------------------------- 7. summary  ----
echo
echo "${c_grn}Done.${c_rst} ${SELF_NAME} (${SELF_IP}) is in ${CLUSTER}."
echo "The Proxbox discovers nodes from the cluster API automatically - refresh it"
echo "and ${SELF_NAME} will appear as a placement target with no further changes."
echo
echo "Sanity peek:"
echo "    pvecm status | sed -n '1,20p'"
echo "    pvesm status"
