# Nodes, scheduling and discovery

Items 12, 13, 16.

## 12 — Node capability detection

The controller knows nothing about a node until that node's agent tells it.
Every 15 seconds the agent posts everything it can determine about itself, plus
everything plugged into it, to `/svc/android/agent/heartbeat`.

What is collected and how — all of it from the node's own filesystem and
standard tools, nothing that needs the Proxmox API:

| Fact | Source |
| --- | --- |
| CPU model, cores | `/proc/cpuinfo`, `os.cpus()` |
| RAM total / available | `/proc/meminfo` (`MemAvailable`, not `MemFree` — free memory on a hypervisor is a meaningless number) |
| Architecture | `os.arch()` |
| KVM | `/dev/kvm` exists |
| Nested KVM | `/sys/module/kvm_{intel,amd}/parameters/nested` |
| VT-x / AMD-V | `vmx` / `svm` in the cpuinfo flags |
| GPU present | `/dev/dri/renderD128` — a render node is the thing that actually matters, not a PCI ID |
| GPU model / vendor | `lspci` VGA line |
| VAAPI | `vainfo` present + a render node |
| Vulkan | `vulkaninfo` present |
| Quick Sync | Intel + a render node |
| USB host | `/dev/bus/usb` exists |
| USB/IP | `usbip` present |
| adb / scrcpy versions | `adb version`, `scrcpy --version` |
| Emulator runtime | `$ANDROID_SDK_ROOT/emulator/emulator` exists **and** `/dev/kvm` exists |
| QEMU runtime | `qemu-system-x86_64` present |
| Waydroid runtime | `waydroid` present |
| Physical ADB runtime | `adb` present |
| Staged images | directory walk of `$ANDROID_SDK_ROOT/system-images`, named exactly as the registry names them |
| Free storage | `df -BG /var/lib/vz` |

A node with no heartbeat for `ANDROID_AGENT_STALE_MS` (60s) is marked
`reachable: false` and skipped by the scheduler. It is not deleted — a node that
comes back keeps its history and its devices.

The resulting card, as the Devices → Nodes view shows it:

```
pve03
i7-8700 · 12 cores · 21 / 32 GB free
KVM yes · nested yes · GPU Intel UHD 630
Runtimes: android-emulator, qemu, physical-adb
USB host yes · 2 devices attached · 4 images staged
```

**Why the agent and not `pvesh`.** Proxmox knows a node's RAM and CPU, but it
does not know whether the Android SDK is installed, whether a render node
exists, which system images are cached, or what is plugged into the USB ports.
Those are exactly the facts Android scheduling turns on.

---

## 13 — The scheduler

`server/android/scheduler.ts`. One function, `planDevice(request, { user })`,
answers "what exactly would we build, where, with what, and why?" — and answers
it identically whether or not anybody then presses the button. The create form
calls it on every keystroke; `POST /svc/android/devices` calls it once and
builds what it returned.

```
 1  resolve the image                     registry lookup, or a clear "no such image"
 2  resolve form factor + profile         explicit > profile's own > image's first
 3  merge display/resources/features      form-factor defaults < profile < request
 4  candidate engines                     image.engines, preference-sorted, honouring a pin
 5  physical short-circuit                is a real device the right answer?
 6  filter nodes by capability            fitEngine(): runtime present, arch, KVM, GPU
 7  filter nodes by free capacity         RAM (with 2 GB headroom), cores
 8  pick storage (QEMU only)              images-capable, ≤90% after, least full first
 9  score what is left                    acceleration > GPU > locality > headroom > load
10  explain the answer                    reasons[] and warnings[], in sentences
```

Then the create path continues:

```
11  create the device via the adapter     AVD / clone / claim
12  watch for boot                        getprop sys.boot_completed == 1
13  attach ADB                            (QEMU: MAC -> address -> adb connect)
14  register the runtime handle           backing.{avd|vmid|serial}
15  apply the requested shape             wm size / wm density / rotation
16  hand the device back to the UI         it has been on screen since step 11
```

### The scoring function, and why each term is there

```
performance   native +400 · good +300 · fair +150 · poor +20
GPU present   +60           (a real render path)
VAAPI         +15           (matters for screen streaming, not for booting)
image staged  +120          (nothing to download — often the difference between
                             15 seconds and 15 minutes)
spare RAM     +8/GB, capped at +100
each device already on the node   -25
```

The cap on spare RAM is deliberate: without it, one big idle node wins
everything and the cluster stops spreading. The busy penalty is what actually
does the spreading, and it is small enough that a well-matched node still beats
an empty badly-matched one.

`reasons[]` is built as scoring happens, so the UI shows the real justification
rather than a rationalisation:

> ✓ Lands on **pve3**
> · pve3 runs x86_64 natively with KVM.
> · It has a usable GPU (Intel UHD 630).
> · It already has this image staged, so nothing has to be downloaded.
> · It is running 2 other Android devices.

### Failing usefully

A refusal is a last resort, and it always carries per-candidate detail:

```
⛔ Nothing in the cluster can run AOSP Android 15 as a Phone right now.
   android-emulator - pve3: 21 GB RAM free, needs 59 GB
   android-emulator - pve6: does not have the android-emulator runtime installed
   Try a smaller size, a different image, or free something up.
```

And when hardware would satisfy what the cluster cannot, the failure says so
instead of stopping at "unsupported":

```
⛔ Nothing in the cluster can run GSI Android 14 (ARM64) as a Large tablet.
   Galaxy Tab S8 on pve6 could do it - ask for a physical device instead.
```

### Storage placement

For QEMU devices only, and deliberately the same rules the existing ProxBox
placement uses so a person who understands why their VM landed on pve3
recognises this: images-capable storages only, must not push the storage past
90% after the new disk, least-full first.

### Reservations and the reapers

Reservation is separate from state, and both the scheduler and the reaper
respect it:

- A device held by someone else is never offered to a new request; a device held
  by **you** is offered back to you first ("re-opening a device you already have
  should hand you back the same one").
- Holds expire after `ANDROID_RESERVATION_TTL_MS` (4h) and the expiry is
  audited.
- Unheld disposable virtual devices are destroyed after 24h. Held ones are left
  alone — the reaper never takes something out from under a person.

All of it runs on one 5-second timer that is started lazily, so a controller
with no Android devices does no Android work at all.

---

## 16 — Physical-device discovery

`server/android/nodes.ts: reconcilePhysical`. This is the part that makes
milestone 2 more than a label.

Each heartbeat carries what `adb devices -l` sees, enriched per device with
`getprop`, `wm size`, `wm density`, `dumpsys battery`, `/proc/meminfo` and
`df /data`:

```
ADB serial · state · connection (usb|tcp) · manufacturer · model · product
Android version · API level · CPU architecture · screen width/height/DPI
orientation · battery % · charging · storage · RAM · USB VID/PID
ro.build.characteristics
```

Reconciliation, on every heartbeat:

- **New serial** → a `DeviceRecord` is created and audited as `device.discover`.
- **Known serial** → facts are refreshed. A device that was re-flashed or updated
  gets its version and API level corrected rather than keeping stale data.
- **Missing serial** → marked `offline` with "Unplugged, or no longer answering
  ADB on this node". **Not deleted.**

Physical ids are derived from the serial (`phy-<hash(serial)>`), so unplugging
and replugging returns the *same* registry row — same id, same history, same
audit trail — rather than creating a duplicate.

### Form-factor inference

Android usually tells us: `ro.build.characteristics` gives `tablet`, `tv`,
`watch` or `automotive` directly. When it does not, we use the same rule Android
itself uses for layout — **smallest width in dp**:

```
smallestDp = min(width, height) / dpi * 160
  >= 720  ->  tablet_large
  >= 600  ->  tablet_small
  else    ->  phone
```

600dp is Android's own tablet boundary, which is why a 1200×1920 @320dpi panel
is a tablet and a 1080×2340 @420dpi one is a phone. Model-name heuristics catch
a couple of cases Android does not label (`TC52` → handheld, `…POS…` → pos), and
an admin can correct any device's form factor afterwards.

### The result

After reconciliation, a Samsung tablet on pve6 and an emulator on pve3 are two
rows in one table with the same fields, the same states, the same reservation
model and the same actions. From the smoke test:

```
PASS  physical device registered - Samsung SM-X706B
PASS  classified as a tablet - tablet_large
PASS  same record shape as virtual devices
PASS  still registered   (after unplug)
PASS  now offline
```

Nothing above `runtime/` can tell the two apart, which was the entire point.
