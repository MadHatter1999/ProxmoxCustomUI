# Networking, storage and security

Items 19, 20, 21.

## 19 — Networking

`data/networks.json` — a network profile is data, like everything else in the
catalogue.

| Profile | Bridge | Firewall | Internet | For |
| --- | --- | --- | --- | --- |
| `default` | vmbr0 | on | yes | The normal case: lab LAN, reachable by ADB |
| `lan` | vmbr0 | off | yes | Reachable from anything on the subnet |
| `internet-only` | vmbr0 | on | yes | Out to the internet, blocked from the rest of the lab |
| `nat` | vmbr0 | on | yes | No inbound; ADB reached through the node agent |
| `no-internet` | vmbr0 | on | no | Testing what an app does with no connectivity |
| `isolated-lab` | vmbr0 + VLAN | on | no | A private lab several devices share |

For QEMU devices these map straight onto the Proxmox `net0` string the adapter
builds:

```
virtio=<our chosen MAC>,bridge=vmbr0[,firewall=1][,tag=<vlan>]
```

For AVD devices the profile is passed to the agent, which today uses it only to
decide whether to pass emulator networking flags; emulator instances sit behind
the emulator's own NAT and are reached through the node's adb either way.

### What is built and what is designed

**Built:** the profile model, bridge/firewall/VLAN fields, and the wiring
through the plan into the VM's `net0`.

**Designed, not built — per-lab isolation.** The `isolated-lab` profile is
where "LAB 007 contains a tablet, a phone and a POS terminal that can see each
other and nothing else" lives. Doing it properly needs three things ProxBox does
not have yet:

1. **A lab object.** Today `labIsolated` is a boolean on the profile; it needs
   to be a first-class record (`lab_id`, name, owner, devices) so several devices
   can be told to join the *same* lab.
2. **A VLAN allocator.** One tag per lab from a configured pool
   (say 700–799), released when the lab is torn down. Without an allocator,
   "custom VLAN" is a field somebody has to fill in correctly by hand, which is
   how two labs end up sharing a tag.
3. **Proxmox firewall groups.** `internet-only` and `no-internet` are only
   honest if they are enforced by a security group applied to the VM's firewall,
   not by a bridge choice. That means creating and maintaining two groups
   (`android-internet-only`, `android-no-internet`) via the PVE firewall API and
   attaching them at create time.

Until those exist, `internet-only` and `no-internet` are **labels that describe
intent, not enforced isolation**, and the network profile list says so in its
descriptions. That is a deliberate choice: an enforcement claim that is not
enforced is worse than an honest gap, particularly on a network that also
carries production machines.

### The shape once built

```
LAB 007  (vlan 707)
├── android-tablet-a    net0: virtio=...,bridge=vmbr0,tag=707,firewall=1
├── android-phone-b     net0: virtio=...,bridge=vmbr0,tag=707,firewall=1
└── android-pos-c       net0: virtio=...,bridge=vmbr0,tag=707,firewall=1
                        firewall group: android-lab-isolated
                        (allow within 707, deny everything else)
```

The controller stays reachable because it brokers ADB through the node agent,
which is on the node itself rather than on the lab VLAN. Isolation of the
devices does not isolate ProxBox from them, which is exactly the property that
makes an isolated lab usable.

---

## 20 — Storage and snapshots

The principle: **copy-on-write wherever the runtime allows, and never three
full copies of the same base image.**

```
BASE IMAGE / TEMPLATE
      |
      +-- DEVICE INSTANCE 1   (delta only)
      +-- DEVICE INSTANCE 2   (delta only)
      +-- DEVICE INSTANCE 3   (delta only)
```

How each runtime gets there:

**QEMU — Proxmox linked clones.** `clone full=0` from a prepared template. The
clone shares the base image's blocks and stores only what it changes. On
`lvmthin` and ZFS storages this is the storage layer's own CoW; on directory
storages it is a qcow2 backing file. Either way three devices off a 12 GB Bliss
template cost 12 GB plus three small deltas.

**QEMU — reset via snapshot rollback.** A device gets a `proxbox-base` snapshot,
and `reset()` is a rollback: seconds, not a rebuild. That is what makes
`reset-on-release` cheap enough to be the default for shared devices.

**AVD — the system image is already shared.** Every AVD off
`system-images;android-35;default;x86_64` reads the same read-only system image
on the node; only `userdata-qemu.img` is per device. A second device off an
image the node already has costs a few hundred megabytes and starts in seconds,
which is exactly why the scheduler scores staged images +120.

**AVD — reset via `-wipe-data`.** Nothing is rebuilt; the userdata image is
discarded on the next start.

**Physical — no storage model.** The device has the storage it has. `persistent`
is the only honest persistence mode, and discovery sets it.

### Persistence modes

| Mode | Meaning | Implementation |
| --- | --- | --- |
| `disposable` | Thrown away when finished | Reaped after 24h if unheld; AVD wipes on restart |
| `persistent` | Keeps its state | Nothing special; survives stop/start |
| `snapshot` | Keep a restore point | `proxbox-base` snapshot taken at first ready |
| `reset-on-release` | Handed back clean | `release` triggers `reset()` in the background |

Disposable is the default, deliberately: a test device that nobody has to
remember to clean up is the thing that makes this subsystem cheap to use.

### Storage placement

Handled by the scheduler, using the rules ProxBox already uses for VM placement:
images-capable storages only, must not exceed 90% after the new disk, least-full
first. The existing SSD-before-spinner tiering in `server/index.ts`
(`getSlowStorages`) is **not** wired into Android placement yet — it is a
private helper in that module, and reaching into it would mean changing working
code. It is the obvious next refinement: extract it, and have both placement
paths call it.

---

## 21 — Security

The rule that shapes everything: **raw ADB is never exposed. The controller
brokers.**

### The chain

```
browser ──PVEAuthCookie──► controller ──HMAC-signed──► node agent ──adb──► device
```

Each hop has its own authentication, and no hop can be skipped:

**Browser → controller.** The same `isSignedIn` check every other `/svc` route
uses: the cookie is validated against Proxmox itself on every request. The
caller's name is read out of the validated ticket for audit and reservations —
a forged name would require a forged ticket, which PVE has already rejected.

**Controller → agent.** HMAC-SHA256 over `timestamp \n method \n path \n
sha256(body)` with a shared secret, and a five-minute skew window. A captured
request is useless a minute later, and a body cannot be altered in flight.
Verification uses `timingSafeEqual`. With no `ANDROID_AGENT_TOKEN` configured,
agents are refused outright and the subsystem stays registry-only.

**Agent → device.** `adb`, on the node, in the node's own USB and network
context. The agent binds a single port and answers nothing that is not signed.

### Injection

Every adb invocation is an **argv array**, never a shell string, on both sides.
A package name, filename or device serial from the UI cannot become a command on
a Proxmox host. Beyond that: package names are validated against
`^[A-Za-z0-9_.]+$`, keycodes against `^[A-Z0-9_]+$`, uploads must be named
`.apk`, and JSON bodies are capped at 2 MB with uploads at 512 MB.

The one deliberate exception is `adb shell <command>`, which is arbitrary by
design — that is what an ADB terminal *is*. It runs in the device's shell, not
the node's, and every invocation is written to the audit log with the caller's
name.

### Authorisation

- **Session ownership.** A reserved device is drivable only by its holder;
  everyone else gets a sentence naming who has it.
- **Reservations expire** after 4h so an abandoned hold cannot lock a device out
  of the pool permanently.
- **Wiping physical hardware is opt-in per device**, set by an admin. The
  default is refusal with an explanation.
- **Destroy is virtual-only** in the UI; destroying a physical device
  unregisters it and does not touch the hardware.

### Audit

Append-only JSONL in the state directory, one object per line:

```json
{"at":1725800000000,"user":"tony@pam","action":"device.shell",
 "deviceId":"and-8f2a…","detail":"pm uninstall com.example.app","ok":true}
```

Every state-changing call writes one, **including failures** — "who tried to
wipe that POS terminal" is exactly the question this has to answer six weeks
later. `GET /svc/android/audit?device=<id>` reads it back newest-first.

### What this does not defend against, stated plainly

- **Agent traffic is HMAC-signed but not encrypted.** Command contents and
  screenshots cross the lab LAN in clear. On a flat trusted lab network that is
  the same posture as the existing Proxmox API traffic; if the lab stops being
  trusted, the agent needs TLS with a pinned certificate, which is a small
  change to `agent-client.ts` and the agent's `createServer`.
- **One shared token for all nodes.** Compromising one node's token gives an
  attacker the ability to impersonate any agent. Per-node keys are the right
  fix and are a strictly better version of the same mechanism.
- **The controller runs as root's PVE token**, exactly like the rest of
  ProxBox. That is an existing, deliberate decision of this app, not one this
  subsystem introduces — but it does mean an authenticated ProxBox user can
  create Android VMs on the cluster, and the audit log is the only thing that
  records who.
- **A device on `default` networking is on the lab LAN.** It can reach
  production. Until the firewall groups in item 19 exist, `internet-only` and
  `no-internet` describe intent rather than enforcing it.
