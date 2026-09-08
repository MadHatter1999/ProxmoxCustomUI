# API, data model and UI integration

Items 22, 23, 24.

## 22 — REST API

Everything under `/svc/android`, mounted by one line in `server/index.ts`, gated
by the same `isSignedIn` check as every other `/svc` route. Errors are
`{ "message": "a sentence a person can act on" }`.

### Catalogue and cluster

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/svc/android/catalog` | images, hardware profiles, form factors, networks, registered runtimes, the Android version table, whether mock is on |
| `GET` | `/svc/android/nodes` | node capabilities, newest heartbeat state |
| `GET` | `/svc/android/audit?limit&device` | audit entries, newest first |

### Registries

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/svc/android/profiles` | a `HardwareProfile`; refuses built-in ids |
| `DELETE` | `/svc/android/profiles/:id` | — (lab-added only) |
| `POST` | `/svc/android/images` | an `AndroidImage`; stored as `userSupplied` |
| `DELETE` | `/svc/android/images/:id` | — (lab-added only) |

### Planning

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/svc/android/plan` | `DeviceRequest` | `{ plan, compatibility }` |

The create form calls this on every keystroke (debounced 350ms). `plan` is the
scheduler's real answer — node, storage, engine, resolved display and resources,
`reasons[]`, `warnings[]` — or a failure with per-candidate `detail[]` and a
`suggestion`. `compatibility` is the card:

```json
{
  "image": "gsi-android-14-arm64",
  "architecture": "arm64",
  "hostArchitecture": "x86_64",
  "bootMethod": "qemu-uefi",
  "runtime": "qemu",
  "kvm": "unavailable-translated",
  "gpu": "none",
  "performance": "poor",
  "support": "experimental",
  "playServices": false,
  "recommended": "A physical ARM device on a node - the cluster is x86-64, so ARM images are translated, not accelerated.",
  "warnings": ["arm64 is emulated instruction-by-instruction on this x86_64 host…"]
}
```

### Devices

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/svc/android/devices` | every device, virtual and physical, one shape |
| `GET` | `/svc/android/devices/:id` | one device |
| `POST` | `/svc/android/devices` | `DeviceRequest`; `409` with detail if unschedulable; `dryRun: true` returns the plan only |
| `POST` | `/svc/android/devices/:id/start\|stop\|reboot\|reset` | lifecycle |
| `DELETE` | `/svc/android/devices/:id` | destroy |
| `POST` | `/svc/android/devices/:id/reserve` | `{ minutes?, note? }` |
| `POST` | `/svc/android/devices/:id/release` | triggers reset for `reset-on-release` |

### Control — all require the reservation, if there is one

| Method | Path | Body / returns |
| --- | --- | --- |
| `GET` | `/svc/android/devices/:id/screen` | `image/png` (or `image/svg+xml` from mock), `no-store` |
| `POST` | `/svc/android/devices/:id/input` | `{type:'tap'\|'swipe'\|'key'\|'text', …}` |
| `POST` | `/svc/android/devices/:id/shell` | `{command}` → `{output}`; **audited** |
| `POST` | `/svc/android/devices/:id/install?name=x.apk` | raw APK body → `{output}` |
| `POST` | `/svc/android/devices/:id/uninstall` | `{packageName}` |
| `POST` | `/svc/android/devices/:id/display` | `{width?, height?, dpi?, orientation?}` |
| `POST` | `/svc/android/devices/:id/sensors` | `{gps?, battery?, fold?}` |
| `GET` | `/svc/android/devices/:id/properties` | full `getprop` map |
| `POST` | `/svc/android/devices/:id/record/start` | → `{path}` |
| `POST` | `/svc/android/devices/:id/record/stop` | → `video/mp4` download |

### Agent intake — signed, no session

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/svc/android/agent/heartbeat` | `x-proxbox-ts` + `x-proxbox-sig` HMAC |

### Websocket

**Deliberately not implemented.** `server/index.ts` documents, at length, that a
raw `ws` server attached to the main HTTP server's `upgrade` event destroys
non-matching upgrade requests and broke the noVNC console. The Android subsystem
adds no websocket rather than risk the working consoles.

The design when it is wanted, following the pattern the repo already proved with
`guacamole-lite`:

```
/android-ws?device=<id>&token=<short-lived>

controller: ws server bound to 127.0.0.1:8083 only
server/index.ts:
  const androidProxy = createProxyMiddleware({
    pathFilter: '/android-ws', target: 'http://127.0.0.1:8083', ws: true })
  // and in loggedUpgrade(), alongside apiProxy and guacProxy:
  androidProxy.upgrade(req, socket, head)

frames  server -> client:  binary, H.264 NAL units (or JPEG while degraded)
events  client -> server:  {"t":"tap","x":..,"y":..}
                           {"t":"key","code":"KEYCODE_BACK"}
                           {"t":"text","v":"hello"}
state   server -> client:  {"t":"state","state":"ready","statusText":null}
```

The token is minted per session by the controller and encodes device id, owner
and an expiry, exactly like the existing RDP token. `DeviceScreen.tsx` is
written so this replaces the `<img>` with a `<canvas>` and changes nothing else.

---

## 23 — Database schema

The subsystem ships with a file-backed store (`store.ts`) implementing the
tables below, because ProxBox has no database today and the whole point was to
drop this in with zero new packages. Writes are write-temp-then-rename, so a
crash cannot leave a half-parsed registry; reads are served from memory.

The schema is the contract. Swapping in SQLite or Postgres is a new `Store`
implementation, not a rewrite of the callers.

```sql
-- Every Android device, virtual and physical. One table, deliberately.
CREATE TABLE android_device (
  id                TEXT PRIMARY KEY,          -- and-<hex> | phy-<hash(serial)>
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL,             -- 'virtual' | 'physical'
  runtime           TEXT NOT NULL,             -- android-emulator|qemu|physical-adb|…
  node              TEXT NOT NULL,
  state             TEXT NOT NULL,             -- provisioning|booting|ready|stopped|offline|error|deleting
  status_text       TEXT,
  error             TEXT,

  image_id          TEXT NOT NULL REFERENCES android_image(id),
  image_name        TEXT NOT NULL,             -- denormalised: images can be deleted
  android_version   TEXT NOT NULL,
  api_level         INTEGER NOT NULL,
  architecture      TEXT NOT NULL,             -- x86|x86_64|arm|arm64

  form_factor       TEXT NOT NULL,
  hardware_profile  TEXT,                      -- null when custom
  display_width     INTEGER NOT NULL,
  display_height    INTEGER NOT NULL,
  display_dpi       INTEGER NOT NULL,
  orientation       TEXT NOT NULL,
  display_unfolded  TEXT,                      -- JSON, foldables only

  cpu               INTEGER NOT NULL,
  memory_mb         INTEGER NOT NULL,
  storage_gb        INTEGER NOT NULL,
  capabilities      TEXT NOT NULL,             -- JSON object

  persistence       TEXT NOT NULL,
  network           TEXT NOT NULL,
  lab_id            TEXT,                      -- reserved for isolated labs

  adb_serial        TEXT,
  adb_endpoint      TEXT,
  adb_reachable     INTEGER NOT NULL DEFAULT 0,
  backing           TEXT NOT NULL,             -- JSON, runtime-private handles

  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  booted_at         INTEGER
);
CREATE INDEX ix_device_node  ON android_device(node);
CREATE INDEX ix_device_state ON android_device(state);
CREATE UNIQUE INDEX ux_device_serial ON android_device(node, adb_serial)
  WHERE adb_serial IS NOT NULL;

-- Separate from state, because "in use" and "running" are different questions
-- and that separation is what makes physical and virtual devices one concept.
CREATE TABLE android_reservation (
  device_id  TEXT PRIMARY KEY REFERENCES android_device(id) ON DELETE CASCADE,
  owner      TEXT NOT NULL,
  since      INTEGER NOT NULL,
  expires_at INTEGER,
  note       TEXT
);

CREATE TABLE android_node (
  node            TEXT PRIMARY KEY,
  agent_version   TEXT NOT NULL,
  endpoint        TEXT,
  last_seen       INTEGER NOT NULL,
  arch            TEXT NOT NULL,
  cpu_model       TEXT,
  cores           INTEGER NOT NULL,
  ram_mb          INTEGER NOT NULL,
  free_ram_mb     INTEGER NOT NULL,
  storage_free_gb INTEGER,
  kvm             INTEGER NOT NULL,
  nested_kvm      INTEGER NOT NULL,
  vtx             INTEGER NOT NULL,
  svm             INTEGER NOT NULL,
  gpu             TEXT,                        -- JSON
  runtimes        TEXT NOT NULL,               -- JSON {runtime: bool}
  usb_host        INTEGER NOT NULL,
  usbip           INTEGER NOT NULL,
  adb_version     TEXT,
  scrcpy_version  TEXT,
  cached_images   TEXT NOT NULL                -- JSON array
);

-- Raw discovery, kept separate from android_device so unplugging a device
-- never loses its registry row, its history or its audit trail.
CREATE TABLE android_physical_report (
  node        TEXT NOT NULL REFERENCES android_node(node) ON DELETE CASCADE,
  serial      TEXT NOT NULL,
  state       TEXT NOT NULL,                   -- device|unauthorized|offline|…
  connection  TEXT NOT NULL,                   -- usb|tcp
  detail      TEXT NOT NULL,                   -- JSON of the full report
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (node, serial)
);

-- Catalogue overlay. The shipped JSON stays in the repo; these are the lab's.
CREATE TABLE android_image (
  id          TEXT PRIMARY KEY,
  definition  TEXT NOT NULL,                   -- JSON AndroidImage
  user_supplied INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE android_hardware_profile (
  id          TEXT PRIMARY KEY,
  definition  TEXT NOT NULL,                   -- JSON HardwareProfile
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

-- Append-only. Every state-changing call, including the failures.
CREATE TABLE android_audit (
  at         INTEGER NOT NULL,
  "user"     TEXT NOT NULL,
  action     TEXT NOT NULL,                    -- device.create|device.shell|…
  device_id  TEXT,
  detail     TEXT,
  ok         INTEGER NOT NULL
);
CREATE INDEX ix_audit_device ON android_audit(device_id, at DESC);
CREATE INDEX ix_audit_at     ON android_audit(at DESC);

-- For item 19's isolated labs, when they are built.
CREATE TABLE android_lab (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  vlan       INTEGER UNIQUE,
  owner      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Two schema decisions worth defending:

**One `android_device` table for physical and virtual.** A `physical_device`
table alongside a `virtual_device` table would push the union back into every
query and every UI component, which is precisely the branching this design
exists to remove. The differences live in `kind`, `runtime` and the
runtime-private `backing` blob.

**`backing` is opaque JSON.** `{avd: "pbx-and-8f2a"}`, `{vmid: 143, storage:
"local-lvm", mac: "02:…"}`, `{connection: "usb", wipeable: 0}`. Nothing outside
the owning adapter reads it, so a new runtime needs no migration.

---

## 24 — ProxBox UI integration points

**No replacement UI.** The Android subsystem is a section inside the shell that
already exists, using the CSS classes and interaction patterns already there.

### What changed in existing files

`src/components/Dashboard.tsx`, three additions totalling six lines:

```tsx
import DevicesPanel from './DevicesPanel'
const [showDevices, setShowDevices] = useState(false)
<button onClick={() => setShowDevices(true)}>Devices</button>
{showDevices && <DevicesPanel username={session.username} … />}
```

`src/styles.css`: rules appended under a marked header. Nothing above that line
is touched — every new selector is new.

`server/index.ts`: an import and `app.use(createAndroidRouter({ isSignedIn }))`,
placed after all existing routes and before the static handler, so it cannot
shadow anything that works today.

### What the section looks like

```
DEVICES

  [17 Android] [11 Virtual] [6 Physical] [9 Available]   6 In use
     ↑ these are filter buttons, not just counters

  AOSP 15                     Samsung SM-X706B
  12" TABLET                  Android 14 · tablet_large
  2560×1600 @320dpi           1600×2560 @274dpi
  x86_64 · Virtual            arm64 · Physical
  Emulator · pve03            Physical · pve06 · R52T90ABCDE
  RUNNING                     AVAILABLE
  [Open] [Turn off] […]       [Open] [Reserve] […]
```

The two cards are the same component with the same actions. `DeviceCard.tsx`
branches on `kind` in exactly three places — the label, whether Start/Turn off
are offered, and whether Destroy is offered — and every one of those is a
statement about what makes sense to a person, not about the implementation.

### Reused conventions

| ProxBox convention | Used by |
| --- | --- |
| `modal-backdrop` / `modal` / `modal-wide`, click-outside to close | all four components |
| `card` / `card-head` / `dot` / `pill` / `cards` grid | `DeviceCard`, node cards |
| `machine-actions`, `machine-sub`, `machine-net` | `DeviceCard` |
| `adv-toggle` collapsible Advanced section | `NewDevice` |
| `upload-progress` bar | APK install |
| `spinner`, `panel-subhead`, `warn`, `error`, `good-note`, `muted` | everywhere |
| Poll on an interval, `stop` flag in the cleanup | `DevicesPanel` (4s) |
| `AuthError` → `onAuthError()` → sign out | every call |

### Where it would go in a permanent nav

The brief sketches `Compute / Virtual Machines / Containers / Storage / Network
/ Devices`. ProxBox today has a single Machines page with modal panels, so
Devices is a modal panel like Nodes and Techs — consistent with what is there
rather than half-migrating the app to a nav it does not have.

When ProxBox does grow a sidebar, Devices moves with a one-line change: the
panel's contents become a route, and the counts row becomes the section header.
Nothing inside `DevicesPanel`, `DeviceCard`, `NewDevice` or `DeviceScreen`
depends on being in a modal.
