Proxbox - add a new node to pb-cluster
======================================

On a freshly-installed Proxmox node (hostname set to the next name e.g. pve5,
static IP on 192.168.200.0/24), plug in this USB and paste ONE line as root:

    mkdir -p /mnt/usb; mount -L ROCKY-BOOKW /mnt/usb 2>/dev/null; apt-get install -y jq sshpass 2>/dev/null || { echo 'deb http://download.proxmox.com/debian/pve trixie pve-no-subscription' > /etc/apt/sources.list.d/pve-no-sub.list; apt-get update; apt-get install -y jq sshpass; }; bash /mnt/usb/proxbox-join/join-proxbox-node.sh

That mounts the USB, installs what it needs, and runs the joiner. You answer
two prompts only: type "pb-cluster" to confirm, and the cluster root password
once. When it's done, the node is in the cluster and the Proxbox treats it like
the others automatically.

(If mount can't find ROCKY-BOOKW, run 'lsblk -f', find the USB partition, and
use 'mount /dev/sdXN /mnt/usb' instead - the label only matters for the mount.)

Afterward, copy the updated nodes.json back onto this USB so the next node
starts from the current list:

    cp /mnt/usb/proxbox-join/nodes.json ./nodes.json.bak 2>/dev/null; cp /root/proxbox-join/nodes.json /mnt/usb/proxbox-join/nodes.json; sync; umount /mnt/usb

Files in this kit:
  join-proxbox-node.sh   the joiner (installs its own deps, reads+updates nodes.json)
  nodes.json             the cluster node list (source of truth; grows itself)
  README.txt             this file
