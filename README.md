# The Proxbox - self-serve VMs (ProxBox)

A TypeScript PWA that acts as the **front end for average people** on the team:
see the live machines, spin one up by filling in a simple form, and connect to it
over RDP - without ever seeing the Proxmox admin UI.

## What a team member sees

1. **Machines** - every VM in The Proxbox as a card: live/off, its address once it's
   up, one-click **Connect (RDP)** (downloads a ready-made `.rdp` file with the
   machine's address and username filled in), Show login, Start / Turn off.
2. **+ New machine** - a plain form:
   - **Name** - what to call it
   - **Image** - the list comes straight from the shared img folder every node
     sees (plus any Proxmox templates as "Ready to use")
   - **Size** - Small / Medium / Large presets
   - **Machine username + password** - the credentials they'll RDP in with
3. The app **places the machine automatically** on whichever host has the most
   free RAM and safe storage headroom (skips anything that would push a storage
   past 90%). If nothing fits, it says so in plain English - which host is short
   on what, and what to do about it.
4. Task progress shows in a small tray; the new machine appears in the list and
   its login stays attached to it ("Show login").

Credentials note: for **template clones** with cloud-init, the username/password
are injected automatically. For **installer images (ISOs)**, the person completes
the OS setup once on the machine's screen using the same credentials they typed -
the app reminds them, and remembers the login either way. Logins are stored in the
VM's Proxmox notes, so lab admins can see them - this is a lab tool, not a vault.

## Run it

```bash
npm install
npm run dev        # development on http://localhost:5173 (proxies /api2 to pve1)
```

Production (what the team uses):

```bash
npm run build      # typecheck + bundle to dist/
npm run serve      # serves dist/ + proxies /api2 → pve1, port 8080
```

`serve` env vars: `PVE_HOST` (default `https://192.168.200.100:8006`), `PORT`
(default `8080`), `HTTPS=1` for a self-signed cert (needed for PWA install away
from localhost). The server runs on any box on The Proxbox LAN - **not** on the
Proxmox nodes.

### Enabling ISO uploads

`PVE_ROOT_TOKEN` - **required** for the **Upload ISO** button to work at all,
for every login including root. Tech accounts (see Techs page) only get
`PVEVMAdmin`, which has no permission to write into storage, so every upload
is routed the same way through a server-side root API token instead of the
signed-in user's own session - one consistent path, not two. To create the
token on pve1:

```bash
pveum user token add root@pam proxbox --privsep 0
```

Copy the printed `full-tokenid` and `value`, then set:

```
PVE_ROOT_TOKEN=root@pam!proxbox=<value>
```

before running `npm run serve`. This token has full root API access - keep it
out of source control (already covered by `.gitignore`) and only run this app
on the trusted lab LAN. Without it, the Upload ISO button will show "No image
storage is reachable" for everyone, including root.

## Notes / limits

- Team members sign in with their own Proxmox account (pam or pve realm); what
  they can do here is bounded by their Proxmox permissions. Create restricted
  accounts for the team rather than sharing root.
- Machine addresses are read via the QEMU guest agent when the guest has it;
  otherwise the card shows "not reported yet" - install the agent in golden
  images to make RDP one-click.
- The proxy trusts pve1's self-signed certificate. Keep this on The Proxbox LAN.
