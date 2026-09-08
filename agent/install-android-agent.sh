#!/usr/bin/env bash
# Install the ProxBox Android node agent on a Proxmox node.
#
# Run it ON the node, as root, with the controller's address and the shared
# token. It installs adb, drops the agent in /opt/proxbox, and enables a
# systemd unit. The Android SDK (for emulator devices) is optional and only
# needed on nodes you want to run AVDs on - see --with-sdk.
#
#   ./install-android-agent.sh \
#       --controller http://proxbox.lab.local:8080 \
#       --token "$(cat /etc/proxbox/android-token)" \
#       [--with-sdk] [--node pve3]
#
# Nothing here touches existing VMs, storage or the cluster config.

set -euo pipefail

CONTROLLER=""
TOKEN=""
NODE_NAME="$(hostname -s)"
WITH_SDK=0
SDK_ROOT="/opt/android-sdk"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --controller) CONTROLLER="$2"; shift 2 ;;
    --token)      TOKEN="$2"; shift 2 ;;
    --node)       NODE_NAME="$2"; shift 2 ;;
    --with-sdk)   WITH_SDK=1; shift ;;
    --sdk-root)   SDK_ROOT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CONTROLLER" ]] || { echo "--controller is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "--token is required" >&2; exit 2; }

echo "==> Installing packages (adb, scrcpy, node)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends android-tools-adb nodejs ca-certificates curl >/dev/null
# scrcpy is optional; it is only used for the higher-quality screen path.
apt-get install -y --no-install-recommends scrcpy >/dev/null 2>&1 || \
  echo "    (scrcpy not available in this repo - the screenshot path still works)"

echo "==> Installing the agent"
install -d -m 0755 /opt/proxbox
install -m 0755 "$(dirname "$0")/proxbox-android-agent.mjs" /opt/proxbox/proxbox-android-agent.mjs

install -d -m 0700 /etc/proxbox
cat > /etc/proxbox/android-agent.env <<EOF
ANDROID_AGENT_TOKEN=$TOKEN
PROXBOX_CONTROLLER=$CONTROLLER
ANDROID_NODE_NAME=$NODE_NAME
ANDROID_AGENT_PORT=9599
ANDROID_SDK_ROOT=$SDK_ROOT
EOF
chmod 0600 /etc/proxbox/android-agent.env

if [[ "$WITH_SDK" == "1" ]]; then
  echo "==> Installing the Android SDK command-line tools into $SDK_ROOT"
  echo "    (only needed on nodes that will run Google emulator devices)"
  apt-get install -y --no-install-recommends default-jre-headless unzip >/dev/null
  install -d -m 0755 "$SDK_ROOT/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
  rm -rf "$tmp"
  yes | "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK_ROOT" \
      "platform-tools" "emulator" >/dev/null
  echo "    SDK ready. System images are downloaded on demand by the controller."
fi

echo "==> Enabling the service"
cat > /etc/systemd/system/proxbox-android-agent.service <<'EOF'
[Unit]
Description=ProxBox Android node agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/proxbox/android-agent.env
ExecStart=/usr/bin/node /opt/proxbox/proxbox-android-agent.mjs
Restart=always
RestartSec=5
# The agent talks to USB devices and (optionally) /dev/kvm, and nothing else.
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=no
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now proxbox-android-agent.service
sleep 2
systemctl --no-pager --lines=10 status proxbox-android-agent.service || true

cat <<EOF

Done. This node should appear in ProxBox under Devices > Nodes within ~15s.

Plug an Android device in over USB, enable USB debugging on it, and tap
"Allow" on its screen once - it will then show up as an available device.

  journalctl -u proxbox-android-agent -f     # watch it
  adb devices -l                             # what the node can see
EOF
