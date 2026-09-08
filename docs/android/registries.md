# Registries and the data model

Items 8, 9, 10, 11, 27, and image importing.

Everything in this file is **data**. The backend does not switch on a form
factor id, a screen shape or an image variant anywhere. Adding a "handheld
scanner" form factor, a 3840×1100 shelf-edge panel profile or an in-house
Android build is a JSON entry, not a code change — that requirement is the
reason the layering looks the way it does.

## Two layers, always

```
server/android/data/*.json        shipped catalogue, read-only, updated by git
        +
$ANDROID_STATE_DIR/*.json         the lab's own: imported images, saved profiles
        =
        what the registry serves (overlay wins on id collision)
```

An overlay entry with the same id as a shipped one replaces it — which is also
how you disable or correct a built-in without editing the repo. An app update
can never overwrite the lab's catalogue, and the registry memoises for 5s so a
`/plan` call on every keystroke costs nothing.

---

## 8 — Image registry

`data/images.json`, served at `GET /svc/android/catalog`.

```json
{
  "id": "aosp-15-x86_64",
  "name": "AOSP Android 15",
  "platform": "android",
  "androidVersion": "15",
  "apiLevel": 35,
  "architecture": "x86_64",
  "variant": "emulator-system-image",
  "formFactors": ["phone", "tablet_small", "tablet_large", "foldable",
                  "kiosk", "pos", "embedded", "headless"],
  "googleServices": false,
  "support": "supported",
  "capabilities": { "touch": true, "gps": true, "fold": true, "...": true },
  "engines": [
    {
      "runtime": "android-emulator",
      "boot": "avd",
      "requiresKvm": true,
      "gpu": "optional",
      "preference": 100,
      "support": "supported",
      "source": { "kind": "sdk-package",
                  "packageName": "system-images;android-35;default;x86_64" }
    }
  ]
}
```

**`engines` is the important field.** An image is not tied to one runtime: it
declares every way it *can* be executed, each with its own real requirements and
its own preference. That is what lets one ARM64 image say "prefer a physical
device, fall back to translation" (see [runtimes.md](runtimes.md) item 15), and
what would let an image be runnable under both QEMU and Waydroid later without
anything else changing.

**`support` is per engine as well as per image**, because the same bits can be
solid under one runtime and rough under another.

**Source kinds** — where the bits actually live:

| kind | Meaning | Used by |
| --- | --- | --- |
| `sdk-package` | An SDK system image, fetched on demand | AVD |
| `pve-iso` | An ISO on Proxmox storage; first boot is an install | QEMU |
| `pve-template` | A prepared template, linked-cloned | QEMU |
| `pve-disk` | A qcow2/raw used as a backing file | QEMU |
| `agent-path` | A file the node already has | any |
| `url` | Fetched on first use, optional sha256 | any |
| `device` | Whatever is flashed on the hardware | physical |
| `none` | — | mock |

The shipped catalogue covers AOSP 15/14/13/11/9/7.1/4.4, Google APIs 14,
Android TV 14, Automotive 14, Wear OS 5, Bliss OS 16, Android-x86 9, a Lineage
placeholder, an ARM64 GSI, the `physical-device` pseudo-image every discovered
device is registered against, and the mock.

Three honesty notes are baked into the data rather than left to folklore:

- Play-certified images (`google_apis_playstore`) are **not** shipped by
  default. They are not rootable and carry their own licence; stage them
  deliberately. The catalogue ships `google_apis` instead and says so.
- **Google TV** is not offered as a virtual device. Its launcher ships on retail
  hardware, not in public system images — so a Google TV in ProxBox is a
  physical device. Android TV is the virtual one.
- Anything marked `userSupplied` (Bliss, Android-x86, Lineage, the GSI) is a
  catalogue *entry*, not a download. ProxBox never fetches these; an admin
  stages them and ProxBox runs what it finds.

### "READY" vs "listed"

An image being in the registry does not mean its bits are on a node. Readiness
is computed, not stored: a node's heartbeat reports `cachedImages`, and the
scheduler scores a node +120 when it already has what is being asked for. The
UI shows the same information, so "AOSP 15 · READY on pve3, pve7" is a fact
about the cluster rather than a flag someone has to remember to update.

---

## 9 — Hardware profile registry

`data/hardware-profiles.json`. A profile is a reusable shape, nothing more:

```json
{
  "id": "tablet-10-landscape",
  "name": "Tablet - 10 inch landscape",
  "formFactor": "tablet_large",
  "display": { "width": 2560, "height": 1600, "dpi": 320, "orientation": "landscape" },
  "resources": { "cpu": 4, "memoryMb": 6144, "storageGb": 32 },
  "capabilities": {}
}
```

Shipped: `phone-small`, `phone-large`, `foldable-book`, `tablet-7`, `tablet-10`,
`tablet-10-landscape`, `tablet-13`, `tv-1080`, `tv-4k`, `pos-10`, `kiosk-1080`,
`embedded-strip`, `automotive-cluster`, `wear-round`, `headless`. **These are
examples, not a fixed set** — the values are not hardcoded anywhere in the
backend.

**Users can save their own.** `POST /svc/android/profiles` writes to the overlay
and marks it `custom: true`. Built-in ids are refused with "…is a built-in
profile — save yours under a different name" rather than being silently
shadowed. `DELETE /svc/android/profiles/:id` removes a lab-added one only.

### The combination is the point

Image and profile are separate so the cross product is free:

```
AOSP 15 + phone-small        AOSP 15 + tablet-13
AOSP 15 + tablet-10          AOSP 15 + pos-10
AOSP 15 + embedded-strip     AOSP 15 + <whatever you type in Advanced>
```

Fifteen profiles × seventeen images is 255 device shapes from one catalogue,
without a single per-combination image.

### Resolution order

`registry.ts: resolveDisplay / resolveResources`, weakest first:

```
form-factor defaults  ->  hardware profile  ->  explicit request overrides
```

So `{ formFactor: "tablet_large", display: { width: 1920, height: 480 } }` is a
tablet that happens to be a letterbox, and it needs no profile to exist for it.
Numbers are clamped to sane bounds (64–7680 px, 60–640 dpi, 1–32 cores,
512 MB–64 GB, 2–512 GB) — the clamp is the only opinion the backend has about
shape.

---

## 10 — Form-factor model

`data/form-factors.json`. A form factor supplies defaults and capability hints
and gives the UI something to group by. That is all it does.

```json
{
  "id": "embedded",
  "name": "Generic embedded display",
  "category": "embedded",
  "characteristic": "default",
  "defaults": { "orientation": "landscape", "width": 1920, "height": 480,
                "dpi": 160, "ramMb": 2048, "cpu": 2, "storageGb": 8 },
  "capabilities": { "touch": true, "keyboard": false, "rotation": false },
  "notes": "Deliberately odd aspect ratios live here."
}
```

Shipped: `phone`, `tablet_small`, `tablet_large`, `foldable`, `kiosk`, `pos`,
`tv`, `automotive`, `wear`, `embedded`, `headless`.

`characteristic` maps to Android's own `ro.build.characteristics` and is passed
to the AVD as its tag, so a TV device gets the TV system UI rather than a phone
UI at TV dimensions.

**Adding one** — say a warehouse scanner with a hardware trigger key:

```json
{
  "id": "handheld_scanner",
  "name": "Handheld scanner",
  "category": "handheld",
  "characteristic": "default",
  "defaults": { "orientation": "portrait", "width": 720, "height": 1280,
                "dpi": 240, "ramMb": 3072, "cpu": 4, "storageGb": 16 },
  "capabilities": { "touch": true, "keyboard": true, "camera_back": true,
                    "rotation": false }
}
```

Drop it in the overlay file. It appears in the Device dropdown, the scheduler
handles it, discovery can classify devices into it, and no TypeScript was
harmed.

---

## 11 — Capability model

One flat boolean record. Devices advertise it; the UI reads it; runtimes
enforce it.

```json
{
  "touch": true, "multitouch": true, "keyboard": true, "mouse": true,
  "dpad": false, "gps": true, "camera_front": true, "camera_back": true,
  "microphone": true, "speaker": true, "bluetooth": false, "nfc": false,
  "accelerometer": true, "gyroscope": true, "rotation": true, "fold": false,
  "fingerprint": true, "telephony": false, "adb": true, "root": true,
  "play_services": false, "screen_record": true
}
```

**Resolution, and why the order matters:**

```
image capabilities
  -> narrowed by form factor        (a TV has no touch)
  -> narrowed by hardware profile   (this profile has no camera)
  -> VETOED by the runtime          (plain QEMU cannot fake a gyroscope)
  -> requested features applied     (but only where the layers above allow)
```

The runtime veto is the load-bearing step. Different runtimes emulate different
hardware successfully, and the image's own metadata does not know which runtime
it landed on. `AvdAdapter` declares `nfc: false, bluetooth: false` and
`QemuAndroidAdapter` declares `gps: false, fold: false, accelerometer: false`
regardless of what any image claims.

If someone asks for a capability the stack cannot provide, the plan comes back
with the capability **off** and a warning: *"gps was asked for but this
image/runtime cannot provide it — it will be off."* A device that lies about its
own hardware is worse than one that admits a gap, because a test suite will
believe it.

---

## 27 — Configuration format

Two kinds of configuration, kept apart on purpose.

**Environment** — deployment facts (`server/android/config.ts`). Every one has a
working default and every default is inert:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANDROID_AGENT_TOKEN` | *(unset)* | Shared secret with node agents. Unset ⇒ agents refused, subsystem stays registry-only |
| `ANDROID_STATE_DIR` | `<repo>/.android-state` | Device registry, node state, audit log, overlay catalogue |
| `ANDROID_DATA_DIR` | `server/android/data` | Shipped catalogue |
| `ANDROID_AGENT_PORT` | `9599` | Port agents listen on |
| `ANDROID_AGENT_STALE_MS` | `60000` | No heartbeat for this long ⇒ node is gone |
| `ANDROID_MOCK` | *(off)* | `1` enables the mock runtime and its image |
| `ANDROID_BRIDGE` | `vmbr0` | Bridge for QEMU Android devices |
| `ANDROID_BOOT_TIMEOUT_MS` | `600000` | Give up waiting for Android to boot |
| `ANDROID_RESERVATION_TTL_MS` | `14400000` | Abandoned holds expire after 4h |
| `ANDROID_DISPOSABLE_MAX_AGE_MS` | `86400000` | Unheld disposables are reaped after 24h |
| `ANDROID_SCREEN_INTERVAL_MS` | `400` | Screen poll cadence |
| `PVE_ROOT_TOKEN` | *(existing)* | Reused, not duplicated — QEMU devices only |

Agent side: `ANDROID_AGENT_TOKEN`, `PROXBOX_CONTROLLER`, `ANDROID_NODE_NAME`,
`ANDROID_SDK_ROOT`, `ANDROID_HEARTBEAT_MS`, written to
`/etc/proxbox/android-agent.env` by the installer.

**JSON catalogue** — lab facts. Images, profiles, form factors, networks. Edited
by an admin or through the API, never by a deploy.

The split is deliberate: `git pull` changes behaviour, not content; adding an
image changes content, not behaviour.

---

## Image importing

`POST /svc/android/images` writes an image into the overlay. The body is an
`AndroidImage` and the response is what was stored:

```json
{
  "id": "custom-android-13-kiosk",
  "name": "In-house kiosk build (Android 13)",
  "androidVersion": "13",
  "apiLevel": 33,
  "architecture": "x86_64",
  "variant": "custom",
  "formFactors": ["kiosk", "pos", "embedded"],
  "googleServices": false,
  "support": "experimental",
  "capabilities": { "touch": true, "multitouch": true, "adb": true },
  "engines": [{
    "runtime": "qemu",
    "boot": "qemu-uefi",
    "requiresKvm": true,
    "gpu": "preferred",
    "preference": 100,
    "support": "experimental",
    "source": { "kind": "pve-iso", "volid": "local:iso/custom-android.iso" }
  }]
}
```

which is the `IMPORT ANDROID IMAGE` form from the brief, field for field:
image, Android version, architecture, runtime, boot mode, form factors, KVM.

**What can be detected automatically, and what cannot.** Worth being straight
about this, because "just inspect the image" is a bigger job than it sounds:

| Field | Detectable? | How |
| --- | --- | --- |
| Boot mode (UEFI/BIOS) | Yes | ISO carries an EFI boot image or it does not |
| Architecture | Usually | ELF headers in the kernel, or the ISO's own naming |
| Android version / API | Sometimes | `build.prop` inside `system.img` — but that means mounting a squashfs inside an ISO, and it fails on anything unusual |
| Form factors | No | It is a policy decision, not a property of the bits |
| KVM required | No | Every x86 Android image *works better* with KVM; whether it is *required* is a judgement |
| Capabilities | No | What an image claims and what actually works differ, which is the whole reason this field exists |

So the import flow asks, with sensible defaults pre-filled where inspection is
reliable. Guessing the rest and being wrong is worse than one form.

Images are **never fetched automatically** for `userSupplied` entries. ProxBox
runs what an admin staged; it does not go to the internet for a ROM on a user's
behalf, which keeps both the licensing and the provenance question where it
belongs.
