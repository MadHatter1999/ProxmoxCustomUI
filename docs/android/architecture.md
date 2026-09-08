# Architecture

Items 1, 2, 3, 25, 26.

## 1 — The subsystem

```
                        PROXBOX CONTROL UI
                    (existing shell, new Devices section)
                                 |
                          PROXBOX API  (Express)
                    /svc/pve  /svc/wims  ...  /svc/android
                                 |
      +--------------------------+--------------------------+
      |              |               |              |        |
  Scheduler    Device registry  Image registry  Profile   Node registry
      |              |               |          registry       |
      +--------------------------+--------------------------+
                                 |
                          Runtime manager
                                 |
      +-------------+------------+------------+-------------+
      |             |            |            |             |
   AVD adapter  QEMU adapter  Physical    Waydroid       Mock
      |             |         adapter    (not shipped)     |
      |             |            |                      in-process
   node agent    Proxmox     node agent
      |          API (root       |
      |          token)          |
   pve02 ...      pve04 ...    pve07 ...
```

Two things cross the boundary out of the controller, and only two:

- **The Proxmox API**, under the existing root token, for QEMU devices. Android
  VMs are ordinary Proxmox VMs on the existing bridges and storages.
- **The node agent**, over a signed HTTP call. It is the only process anywhere
  that runs `adb`.

The browser never speaks ADB, never speaks to a node agent, and never sees a
device serial it could connect to itself. Everything is brokered.

### Where it sits relative to what already exists

The subsystem reuses ProxBox's existing decisions rather than restating them:

| Existing ProxBox decision | How Android reuses it |
| --- | --- |
| Everything server-side runs as root's API token; the app mediates permissions | Same. `pve.ts` reads the same `PVE_ROOT_TOKEN` |
| `isSignedIn` gates every `/svc` route | Same middleware gates every `/svc/android` route |
| Bodies are read raw; there is no global body parser | The Android router reads raw too — a global parser would break the streamed ISO/WIM uploads |
| Placement fills SSDs before spinners and never pushes a storage past 90% | The scheduler's storage step uses the same 90% cap and the same "most free first" rule |
| A VM's ProxBox metadata lives in its description as `proxbox:{...}` | Android VMs carry `proxbox-android:{...}` in theirs, so a device is still recognisable from the Proxmox UI |
| The websocket upgrade path is fragile and has been broken once | The Android subsystem adds **no** websocket. See [remote-control.md](remote-control.md) |

---

## 2 — The `AndroidDevice` abstraction

`server/android/runtime/adapter.ts`. One interface, four implementations.

```ts
interface AndroidRuntimeAdapter {
  kind: RuntimeKind
  name: string
  capabilities: Partial<Capabilities>   // what this RUNTIME can honour
  available(): Promise<boolean>

  // lifecycle - allowed to be slow, always idempotent
  create(plan, ctx): Promise<DeviceRecord>
  start(device): Promise<void>
  stop(device): Promise<void>
  reboot(device): Promise<void>
  reset(device): Promise<void>          // back to base, same identity
  destroy(device): Promise<void>
  status(device): Promise<DeviceStatus> // cheap poll

  // control - assumes 'ready', throws a human sentence if not
  shell(device, command): Promise<string>
  installApk(device, apk): Promise<string>
  uninstall(device, packageName): Promise<string>
  pushFile(device, remotePath, data): Promise<string>
  pullFile(device, remotePath): Promise<Buffer>
  screenshot(device): Promise<ScreenShot>
  startRecording(device): Promise<string>
  stopRecording(device): Promise<Buffer>
  properties(device): Promise<Record<string, string>>

  // input
  tap(device, x, y); swipe(device, x1, y1, x2, y2, ms)
  key(device, keycode); text(device, value)

  // shape and sensors
  setOrientation(device, orientation)
  setDisplay(device, { width, height, dpi })
  setGps(device, lat, lon, altitude?)
  setBattery(device, pct, charging)
  setFold(device, folded)
}
```

Three design decisions worth defending:

**Capabilities live on the runtime, not only on the image.** The AVD can inject
a fold event; plain QEMU cannot, whatever an image's metadata claims. So each
adapter declares what it can honour and that declaration is the last word when
a device's capability set is resolved (`registry.ts: resolveCapabilities`). The
resolution order is: image → form factor → hardware profile → **runtime veto** →
the requester's explicit features. Asking for GPS on a runtime that has none
gets you no GPS *and a warning*, never a device that lies about itself.

**Unsupported is a typed error, not a silent no-op.** `UnsupportedByRuntime`
carries the runtime name and what was attempted, so the UI can say "Setting a
position on Galaxy Tab S8 (a real device needs a mock-location app installed and
selected in developer options)" instead of appearing to work.

**Not-ready is a different typed error.** `DeviceNotReady` includes the device's
current state and status text. "Booting (waiting for the device to pick up an
address)" is a fundamentally different problem from "this runtime can't do that"
and the UI should never conflate them.

### The state model

One state enum for every kind of device:

```
provisioning -> booting -> ready -> stopped
                   |         |
                   v         v
                 error    offline      (physical: unplugged; virtual: agent gone)
                                       deleting -> (gone)
```

Reservation is **separate** from state, which is what lets "AVAILABLE" and
"IN USE" mean the same thing for an emulator and a POS terminal:

```
state = ready,  reservation = null        -> AVAILABLE
state = ready,  reservation = {owner:...} -> IN USE by that person
state = offline                           -> OFFLINE, whoever held it
```

---

## 3 — Runtime adapter architecture

```
        AndroidRuntimeAdapter  (interface)
                   |
        +----------+-----------------------------+
        |                                        |
  AdbBackedAdapter (abstract)               MockAdapter
        |                                   (implements directly)
        +--------------+--------------+
        |              |              |
   AvdAdapter    QemuAndroidAdapter  PhysicalAdbAdapter
```

`AdbBackedAdapter` is the load-bearing class. Once Android is up and ADB
answers, driving it is identical whether the OS is inside Google's emulator,
inside a Proxmox VM, or on a tablet in the workshop. So the **entire control
surface is written exactly once**, in adb terms, and each concrete adapter
implements only what genuinely differs: how the thing comes into existence, and
how it starts and stops.

Concretely, `adb-base.ts` owns: shell, install, uninstall, push, pull,
screenshot, record start/stop, properties, tap, swipe, key, text, orientation,
display, battery, and the universal readiness check. The three real adapters add
roughly 150 lines each on top of that, and two of them override exactly one
sensor method.

That ratio is the abstraction working.

### What each adapter overrides, and why

| Adapter | Overrides | Reason |
| --- | --- | --- |
| AVD | `setGps`, `setFold`, `setBattery` | It has the emulator console (`adb emu ...`) — a side channel into the OS that no other runtime has |
| QEMU | `status`, `reboot` | No guest agent, so `status` also has the job of finding the VM's address and attaching ADB; reboot goes through Proxmox |
| Physical | `status`, `setGps` | Discovery is the source of truth for whether it is there at all; and a real device's GPS is its GPS |
| Mock | everything | It implements the interface directly; there is no adb underneath |

### Adding a runtime

One registration in `runtime/index.ts`:

```ts
this.register(new WaydroidAdapter())
```

Nothing above the runtime layer changes. The scheduler discovers the new kind
through `runtimes.kinds()`, images opt into it by adding an engine entry, and
the UI's advanced runtime picker is populated from the same list.

---

## 25 — Repository layout

The subsystem is one directory on the server, one client module, four
components, one agent directory and one docs directory. Nothing is scattered.

```
ProxMoxFix/
├── server/
│   ├── index.ts                     unchanged except 2 lines (import + mount)
│   ├── tsconfig.json                NEW - typechecking for server/android
│   └── android/                     NEW - the whole subsystem
│       ├── types.ts  config.ts  registry.ts  compat.ts  scheduler.ts
│       ├── store.ts  nodes.ts  agent-client.ts  pve.ts  routes.ts  util.ts
│       ├── runtime/
│       │   ├── adapter.ts  adb-base.ts  index.ts
│       │   └── avd.ts  qemu.ts  physical.ts  mock.ts
│       └── data/
│           ├── images.json  hardware-profiles.json
│           └── form-factors.json  networks.json
├── agent/                           NEW - what runs on the nodes
│   ├── proxbox-android-agent.mjs
│   └── install-android-agent.sh
├── src/
│   ├── android.ts                   NEW - client API + types
│   └── components/
│       ├── Dashboard.tsx            +1 button, +1 panel
│       ├── DevicesPanel.tsx         NEW
│       ├── NewDevice.tsx            NEW
│       ├── DeviceCard.tsx           NEW
│       └── DeviceScreen.tsx         NEW
└── docs/android/                    NEW - these documents
```

State lives outside the repo entirely, in `ANDROID_STATE_DIR`
(default `.android-state/`): the device registry, node heartbeats, the audit
log, and the admin's own imported images and saved profiles. An app update can
never overwrite the lab's catalogue, and a `git clean` can never destroy the
device registry.

---

## 26 — Service layout

Three processes, no new daemons on the controller.

**1. The ProxBox controller** — the existing Express app, one extra router. It
owns the registries, the scheduler, the device state machine, the boot watcher
and the reapers. Background work is a single 5-second timer, started lazily:
a controller with no Android devices does no Android work at all.

**2. The node agent** — one `node` process per participating node, ~9 MB RSS
idle, systemd-managed. Stdlib only. It heartbeats every 15s and otherwise waits
to be told what to do. It is the only process that runs `adb`, `emulator` or
`avdmanager`.

**3. Per-device processes on nodes** — an `emulator` process per AVD device
(spawned detached by the agent, tracked by AVD name), or a QEMU process managed
entirely by Proxmox. Physical devices have no process.

### Failure behaviour, stated deliberately

| What breaks | What happens |
| --- | --- |
| Controller restarts | Devices keep running. The registry is on disk; the watcher re-attaches on the next tick. Nothing is orphaned |
| A node agent dies | Its node goes `reachable: false` after 60s. Its devices go `offline`, not deleted. Scheduling skips the node |
| A node reboots | Emulator devices are gone; they show as `offline` and can be started again. QEMU devices come back with the node (Proxmox's job). Physical devices re-register on the next heartbeat |
| A device never boots | The watcher gives up after `ANDROID_BOOT_TIMEOUT_MS` (10 min) and sets `error` with a sentence saying so — it never sits "booting" forever with nobody told why |
| Somebody forgets a disposable device | The reaper destroys it after 24h, but only if nobody holds a reservation on it |
| A reservation is abandoned | It expires after 4h and the device becomes available again |
| The Proxmox API is down | QEMU devices cannot be created or controlled; AVD and physical devices are unaffected. This is deliberate — the two paths share nothing at runtime |
