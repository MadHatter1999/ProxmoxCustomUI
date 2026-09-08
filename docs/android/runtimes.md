# Runtimes

Items 4, 5, 6, 7, 14, 15.

Four adapters exist. Which one runs a given request is the scheduler's decision,
not the user's — though an advanced user can pin one.

| Runtime | Best at | Cannot do |
| --- | --- | --- |
| `android-emulator` (AVD) | Arbitrary screen shapes, sensor injection, fold, GPS, fast disposable devices | Anything non-x86; needs KVM; not a real radio, camera or NFC element |
| `qemu` | Android-x86 / Bliss / Lineage / GSI, desktop-ish Android, linked clones, ARM under translation | No sensor injection, no console channel; resolution is a boot-time property |
| `physical-adb` | Real radios, cameras, NFC, scanners, vendor ROMs, ARM64 at full speed | Cannot be created on demand; sensors are real; wiping is dangerous |
| `mock` | Developing the controller and UI with no hardware | Everything else |

---

## 4 — Google AVD adapter

`server/android/runtime/avd.ts`

**Why it is the default.** The AVD's skin *is* the device shape — width, height
and density are three lines in `config.ini`. That is what makes milestone 1
honest: one system image, `system-images;android-35;default;x86_64`, backs both
the 1080×2400 phone and the 2560×1600 tablet, and the 1920×480 strip display,
and the 454×454 watch. No per-shape image and, more importantly, no per-shape
code.

**The side channel.** It is the only runtime with a path into the OS that does
not require an app on the device: the emulator console, reached as
`adb -s emulator-5554 emu <command>`. That gives GPS fixes (`geo fix <lon> <lat>`
— longitude first, which is the classic way to end up testing in the Gulf of
Guinea), fold and unfold, battery capacity and AC state. The scheduler prefers
this runtime for anything sensor-heavy for exactly that reason.

**Flow.**

```
create  ->  agent.ensureImage(node, "system-images;android-35;default;x86_64")
        ->  agent.createAvd(...)   avdmanager create avd + config.ini merge
        ->  agent.startAvd(...)    emulator -avd X -port N -no-window -gpu ...
        ->  serial "emulator-<port>"
watcher ->  getprop sys.boot_completed == 1  ->  ready
        ->  wm size / wm density applied to hit the exact requested shape
```

**GPU choice** is made per node from its reported capability: `host` when the
node has a DRI render node, `swiftshader_indirect` otherwise. Never `auto` —
`auto` on a headless hypervisor picks badly.

**Reset** is `-wipe-data` on the next start. A disposable device is therefore
free to reset: no rebuild, no re-download.

**Hard requirements**, checked in `compat.ts` before a node is considered:
x86 or x86_64 image, and `/dev/kvm`. Both are non-negotiable — the emulator
without KVM is not slow, it is unusable.

**Node prep runbook** (nodes you want to run emulator devices on):

```bash
# On the node, as root:
agent/install-android-agent.sh \
    --controller http://proxbox.lab.local:8080 \
    --token "$(cat /etc/proxbox/android-token)" \
    --with-sdk

# Verify: KVM present, SDK present, agent reporting
ls -l /dev/kvm
/opt/android-sdk/emulator/emulator -version
journalctl -u proxbox-android-agent -n 20
```

System images are downloaded on demand by the controller
(`POST /sdk/ensure` → `sdkmanager --install`) the first time a node is asked for
an image it does not have. Nodes that already have it score +120 in placement,
so a second device off the same image lands on the same node and starts in
seconds rather than after a 1.5 GB download.

---

## 5 — QEMU Android adapter

`server/android/runtime/qemu.ts`

**Why it exists.** Not everything is an emulator system image. Bliss OS,
Android-x86, community Lineage x86 builds, GSIs and anything an admin stages
themselves are full operating systems that boot on PC hardware. This adapter
runs them as ordinary Proxmox VMs — same bridges, same storages, visible in the
Proxmox UI, backed up by whatever backs up everything else.

**Copy-on-write comes free.** A prepared template plus `clone full=0` is a
linked clone. Three devices from one base image cost one base image plus three
deltas, which is exactly the storage model asked for:

```
BASE TEMPLATE (Bliss OS 16, installed once)
      |
      +-- device 1  (delta only)
      +-- device 2  (delta only)
      +-- device 3  (delta only)
```

**The address problem, and how it is solved.** Android-x86 does not ship
`qemu-guest-agent`, so ProxBox cannot read the VM's address the way it reads a
Windows VM's. Instead the controller **chooses the MAC itself** at create time
(`randomMac()` — locally administered, `02:xx:...`) and asks the node agent to
resolve it:

```
controller: create VM with net0=virtio=02:AB:CD:EF:12:34,bridge=vmbr0
   ...boot...
controller -> agent:  POST /net/ip-for-mac {mac}
agent:      ip neigh show | match MAC
            (if absent) broadcast-ping the bridge, re-read the table
agent    -> controller: {ip}
controller -> agent:  POST /connect {target: "<ip>:5555"}
   ...device is now an ordinary ADB device...
```

This is why the base template **must have ADB over TCP enabled**. That is a
one-time preparation step, not something the adapter can do for you — there is
no way in before adb is listening.

**Resolution.** A VM boots at whatever its kernel command line says, so the
requested shape is applied to Android after boot with `wm size` / `wm density`,
by the same code path everything else uses. This works well and is how one
Bliss image serves a 1280×800 POS terminal and a 1920×480 strip display — but
be aware it is a display *override*, so the boot splash and recovery are still
at the native resolution.

**Base template runbook** (once per image, then reused forever):

```bash
# 1. Create a VM from the ISO through ProxBox (Create device picks the ISO
#    source automatically and tells you the first boot is an install).
# 2. Complete the Android installer on its screen: install to the virtual disk,
#    install GRUB, do NOT install /system as read-write unless you need to.
# 3. Boot it, finish first-run setup, then enable ADB over TCP permanently:

su
setprop service.adb.tcp.port 5555
stop adbd && start adbd
# make it survive a reboot - Android-x86/Bliss read this on boot:
echo "service.adb.tcp.port=5555" >> /system/build.prop     # /system must be rw
# Settings > System > Developer options > USB debugging: ON

# 4. Shut it down. On the Proxmox host:
qm template <vmid>

# 5. Register it as an image (Devices > images, or POST /svc/android/images)
#    with source { "kind": "pve-template", "vmid": <vmid>, "node": "pveN" }
```

From then on every device off that image is a linked clone that boots in
seconds and is adb-reachable without a human touching it.

**Reset** is a rollback to the `proxbox-base` snapshot — seconds, not a rebuild.

---

## 6 — Physical ADB adapter

`server/android/runtime/physical.ts`

**The claim, not the create.** A physical device is not built, it is found and
reserved. That is the only difference visible from outside; `create()` resolves
the plan's `claimDeviceId`, takes the reservation, and optionally reshapes the
device with `wm size` / `wm density` if the request asked for a specific
profile. Everything after that is the shared adb control surface.

That last point is worth stating: **a 10" Samsung tablet can be asked to behave
like a phone.** `wm size 1080x2340 && wm density 420` re-lays-out the whole
system UI live. Responsive-layout testing on real hardware, without owning
fifteen devices.

**Honest limits, enforced in code, not just documented:**

- **No sensor injection.** `setGps` throws with an explanation naming what would
  be required (a mock-location app installed and selected in developer options).
  It does not silently succeed.
- **Wiping is opt-in per device.** `reset()` refuses unless the device record
  carries `backing.wipeable === 1`, which an admin sets deliberately. Nobody
  should be able to factory-reset the workshop's only Zebra TC52 from a web page
  by mis-clicking. The error says so in as many words.
- **There is no "off".** `stop()` locks the screen and says "the device itself
  stays powered", because pretending a USB-attached tablet can be powered down
  from a web UI would be a lie.
- **Unauthorised is its own state.** A device showing "Allow USB debugging?"
  reports as `error` with "somebody has to tap Allow on it once" — not as
  offline, and not as a mysterious failure.

**Discovery is the source of truth.** `status()` checks the node's last
heartbeat first: if the agent no longer lists the serial, the device is
offline whatever adb might say. Unplugging marks it offline and *keeps the
record* — the same registry row comes back when it is plugged in again, because
physical ids are derived from the serial (`phy-<hash(serial)>`).

**Node prep runbook:**

```bash
# The install script already installs android-tools-adb. Then, per device:
# 1. Enable Developer options + USB debugging on the device.
# 2. Plug it in, and on the node:
adb devices -l                  # will show "unauthorized"
# 3. Tap "Allow USB debugging" (and "always allow from this computer") on the
#    device's own screen. It then shows as "device" and appears in ProxBox.

# For wireless ADB (a Pixel on a desk, not on a cable):
adb -s <serial> tcpip 5555
adb connect <device-ip>:5555    # the agent reports it as a tcp connection
```

USB passthrough into a VM is deliberately *not* used. The agent talks to the
device on the node itself, which means one device can be shared, brokered and
audited rather than being locked to whichever VM claimed the USB port.

---

## 7 — Does Waydroid deserve an adapter?

**Assessment: not yet. Do not build it now.**

Waydroid runs Android in an LXC container on the host's own kernel. The appeal
is density: no VM, no second kernel, no KVM tax. On a cluster of older PCs,
"thirty Android instances on one node instead of three" is a genuinely
attractive number.

Four things stop it being worth an adapter today:

1. **One instance per host, realistically.** Waydroid is built around a single
   container named `waydroid` with a single `/var/lib/waydroid` state directory.
   Multi-instance requires either running it inside nested containers or patching
   the tooling, and neither is something to depend on for a lab that has to
   keep working. A runtime that can only produce one device per node loses most
   of the density argument that motivated it.

2. **Kernel modules on a hypervisor.** It needs `binder` (and historically
   `ashmem`) available in the running kernel. Proxmox kernels do generally carry
   binder, but this makes the Android subsystem's viability depend on a Proxmox
   kernel upgrade decision, on a cluster whose job is running everyone else's
   VMs. That is a bad trade for a lab tool.

3. **One Android version per host.** The container runs whichever LineageOS-based
   image was initialised. Multi-version testing — which is most of why this
   subsystem exists — would mean re-initialising the host between requests.

4. **It needs a Wayland compositor.** Headless means running `cage` or `weston`
   per node just to give it something to render into. More moving parts on a
   hypervisor, for a screen we then have to capture anyway.

**What would change the answer.** If ProxBox ever needs *many cheap headless
instances of one Android version* — a hundred-device instrumentation farm, say —
Waydroid's density becomes the right trade and multi-instance becomes worth the
engineering. At that point it is a new file:

```ts
// runtime/index.ts
this.register(new WaydroidAdapter())
```

`WaydroidAdapter` would extend `AdbBackedAdapter` (Waydroid devices are ordinary
adb devices, usually at `192.168.240.112:5555`), implement `create` as
`waydroid init` + container start, declare `capabilities` with `gps: false,
fold: false` like the QEMU adapter, and add `waydroid: true` detection to the
agent — which it already reports. Nothing else in the subsystem changes. The
design is ready for it; the case for it is not made.

---

## 14 — Android version compatibility model

The rule: **never conflate "bootable" with "useful"**. The registry exposes the
difference rather than picking an arbitrary floor like Android 11.

`compat.ts` carries the table, and `/svc/android/catalog` serves it to the UI.
Each row states six separate things:

- `bootable` — will it start at all under one of our runtimes
- `usable` — would a person get work done on it
- `accelerated` — KVM + a GPU path, or software all the way down
- `emulatorImages` — does Google still ship a system image for it
- `playServices` — can Play Services realistically run on it today
- `appTesting` — recommended / useful / niche / no

The practical range and why:

| Android | API | Verdict | Note |
| --- | --- | --- | --- |
| 16 | 36 | experimental | Stage as published; experimental until we have run it here |
| 15 | 35 | supported | Default for new devices |
| 14 | 34 | supported | Also the TV / Automotive / Wear baseline |
| 13 | 33 | supported | Where Bliss 16 and most current x86 builds sit |
| 12–10 | 31–29 | supported | Ordinary |
| 9 | 28 | legacy, useful | Last Android-x86 release. Good regression target |
| 8.1 | 27 | legacy, useful | |
| 7.1 | 25 | legacy, useful | Play Services era ended; app-only testing |
| 6 | 23 | legacy, niche | The runtime-permissions boundary — genuinely useful for permission-flow regressions |
| 5 | 21 | legacy, niche | Software rendering; slow but it works |
| 4.4 | 19 | legacy, **not usable** | Boots, installs APKs. No multi-touch, no screen recording, no modern sensor injection. Prove-it-launches only |
| 4.1–4.3 | 16 | legacy, not usable | The practical floor. Expect to fight it |
| ≤4.0 | 15 | **not offered** | Images are ARM-only or gone from the SDK, and current adb/emulator builds no longer handle them. This is the one place the answer is genuinely "no" |

The image registry entry for Android 4.4 says all of this in its `capabilities`
map — `multitouch: false`, `screen_record: false` — so the UI greys out screen
recording rather than offering a button that fails.

---

## 15 — ARM / x86 compatibility model

The cluster is x86-64. That fact drives everything here.

```ts
FAMILY = { x86: 'x86', x86_64: 'x86', arm: 'arm', arm64: 'arm' }
hostCanAccelerate(host, guest) =
    sameFamily(host, guest) && !(guest is 64-bit && host is 32-bit)
```

Four outcomes, each with a different answer rather than one blanket refusal:

**Same family, KVM present** — the normal path. `performance: 'native'` when the
node also has a GPU, `'good'` without. An x86 (32-bit) image on an x86_64 host
is this case too.

**Same family, KVM absent** — the AVD runtime is refused outright (it is
unusable without KVM); QEMU is allowed if the image does not require KVM, and
reports `performance: 'fair'` with a warning about software rendering.

**Cross-family (ARM on x86)** — only QEMU can do it, and only through TCG
instruction translation. The compatibility card says so plainly:

```
IMAGE          GSI Android 14 (ARM64)
ARCH           arm64
HOST ARCH      x86_64
BOOT METHOD    qemu-uefi
KVM            Not usable - translated
GPU            none
PERFORMANCE    Slow - instruction translation
RECOMMENDED    A physical ARM device on a node
```

and the plan carries the warning "arm64 is emulated instruction-by-instruction
on this x86_64 host (QEMU TCG). Expect a slow boot and single-digit frame rates
— fine for a headless run, painful to drive by hand."

**Cross-family, and a real ARM device is free** — the interesting case, and the
one that makes this worth building. An image can declare *two* engines, and the
physical one can have the higher preference:

```json
"engines": [
  { "runtime": "qemu",         "preference": 10,  "gpu": "none",  "..." },
  { "runtime": "physical-adb", "preference": 100, "gpu": "none",  "..." }
]
```

The scheduler tries engines in preference order, so an ARM64 request is
satisfied by a real ARM64 tablet on a node when one is available, and only falls
back to translation when it is not. Verified in the offline smoke test:

```
=== ARM64 request steers to real hardware instead of refusing ===
PASS  ARM64 satisfied by the physical tablet - physical-adb on pve6
```

And when no device is free, the failure names the way out rather than saying
"unsupported":

> Nothing in the cluster can run GSI Android 14 (ARM64) as a Large tablet right
> now. **Galaxy Tab S8 on pve6 could do it — ask for a physical device instead.**
