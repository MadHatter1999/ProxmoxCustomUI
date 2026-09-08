# Remote control and sensors

Items 17, 18.

## 17 — Remote control architecture

One control API, consumed by one UI component, backed by every runtime.

```
browser  ──HTTP──►  ProxBox controller  ──signed HTTP──►  node agent  ──adb──►  device
   ▲                       │
   └───── screen frames ───┘
```

The browser never holds a device serial it could reach, never speaks ADB, and
never talks to a node agent. That is the security story, and it is also why the
same component works for a physical Zebra scanner and a headless emulator.

### The common surface

Everything asked for in the brief, and which runtimes honour it:

| Action | AVD | QEMU | Physical | How |
| --- | :-: | :-: | :-: | --- |
| View screen | ✓ | ✓ | ✓ | `exec-out screencap -p` |
| Touch / tap | ✓ | ✓ | ✓ | `input tap` |
| Swipe / drag | ✓ | ✓ | ✓ | `input swipe` |
| Multi-touch | — | — | — | Needs `sendevent`; see below |
| Keyboard | ✓ | ✓ | ✓ | `input text` / `input keyevent` |
| Home / Back / Recents | ✓ | ✓ | ✓ | keyevents |
| Power / Volume | ✓ | ✓ | ✓ | keyevents |
| Rotate | ✓ | ✓ | ✓ | `settings put system user_rotation` |
| Screenshot | ✓ | ✓ | ✓ | same as the screen frame, downloaded |
| Screen recording | ✓ | ✓ | ✓ | `screenrecord`, SIGINT to finish, then pull |
| ADB shell | ✓ | ✓ | ✓ | `adb shell <cmd>`, audited |
| Install APK | ✓ | ✓ | ✓ | streamed to the node, `adb install -r -g` |
| Uninstall | ✓ | ✓ | ✓ | `adb uninstall` |
| Push / pull file | ✓ | ✓ | ✓ | `adb push` / `exec-out cat` |
| Reboot | ✓ | ✓ | ✓ | `adb reboot` (QEMU: via Proxmox) |
| Reset / wipe | ✓ | ✓ | opt-in | `-wipe-data` / snapshot rollback / refused unless marked wipeable |
| Change resolution | ✓ | ✓ | ✓ | `wm size` |
| Change DPI | ✓ | ✓ | ✓ | `wm density` |
| Set GPS | ✓ | ✗ | ✗ | emulator console only |
| Set orientation | ✓ | ✓ | ✓ | `user_rotation` |

Where a cell is not a tick, the adapter throws `UnsupportedByRuntime` with a
sentence naming what would be required. It never silently no-ops.

**Multi-touch** is the one item in the brief not delivered. Doing it properly
means synthesising `/dev/input` events with `sendevent`, which requires knowing
each device's input device node and its ABS axis ranges — per device, and often
per Android version. It is a genuine piece of work rather than a missing flag,
and pinch-zoom is not worth blocking the rest of the subsystem on. When it is
wanted, it belongs in `adb-base.ts` as `pinch()` / `multiTouch()` with the axis
probing cached on the device record, and every runtime inherits it at once.

### The screen: what is built, and the upgrade path

**Built now: polled screenshots.** The stage renders
`<img src="/svc/android/devices/:id/screen?f=N">` and requests the next frame
only once the previous one has painted, so a slow device degrades to a lower
frame rate instead of building a backlog of stale screenshots. Roughly 2 fps on
a 1080p device over the lab LAN.

Three reasons this is the right *first* implementation and not a shortcut:

1. **It works identically on every runtime**, including a headless emulator and
   a locked-down POS terminal, with no codec support required in the browser.
2. **It needs no second websocket.** `server/index.ts` carries a comment
   explaining that a raw `ws` server attached to the main HTTP server's
   `upgrade` event *actively destroys* upgrade requests that do not match its
   path — and that this broke the noVNC console the moment it was added. The
   Android subsystem does not go near that path.
3. **Input is decoupled from video.** Taps and keys are separate requests, so
   the control path stays responsive even when frames are slow.

**The upgrade, when frame rate matters:** H.264 over a websocket, following
exactly the pattern this repo already proved correct for Guacamole —

```
agent:      adb exec-out screenrecord --output-format=h264 - 
                 │  (or scrcpy-server, which also gives multi-touch injection)
                 ▼
controller: ws server on 127.0.0.1:8083, its own port, NOT the main upgrade path
                 ▼
server/index.ts: createProxyMiddleware({ pathFilter: '/android-ws', ws: true })
                 and one more `androidProxy.upgrade(req, socket, head)` in
                 loggedUpgrade(), exactly alongside apiProxy and guacProxy
                 ▼
browser:    WebCodecs VideoDecoder -> <canvas>
```

`DeviceScreen.tsx` is written so this swap replaces the `<img>` with a
`<canvas>` and changes nothing else: the coordinate mapping already works from
the rendered element's own natural size, and every input path is already
independent of how the frame arrived.

That change touches `loggedUpgrade`, which is currently working code carrying
the noVNC and RDP consoles. It should be made deliberately, with both consoles
tested, and not folded into an unrelated commit.

### Access control on every control call

`routes.ts: mayControl` — a device with a reservation can only be driven by its
holder. An unheld device can be driven by anyone signed in. The rejection is a
sentence, not a 403: *"Galaxy Tab S8 is in use by sarah@pam. Ask them to release
it, or wait for the hold to expire."*

Every shell command, install, uninstall and display change is written to the
audit log with the caller's name. The ADB shell is the most powerful thing this
subsystem hands out, so all of them are on the record.

---

## 18 — Sensor simulation

Sensors are the clearest case of "different runtimes emulate different hardware
successfully", which is why the capability model has a runtime veto at all.

| Sensor | AVD | QEMU | Physical | Mechanism |
| --- | :-: | :-: | :-: | --- |
| GPS position | ✓ | ✗ | ✗ | `adb emu geo fix <lon> <lat> [alt]` |
| Battery level | ✓ | ✓ | ✓ | `adb emu power capacity` → falls back to `dumpsys battery set level` |
| Charging state | ✓ | ✓ | ✓ | `adb emu power ac` → falls back to `dumpsys battery set ac` |
| Fold / posture | ✓ | ✗ | ✗ | `adb emu fold` / `unfold`, and only if created foldable |
| Orientation | ✓ | ✓ | ✓ | `settings put system user_rotation` |
| Accelerometer | ✓ | ✗ | real | AVD `hw.accelerometer` |
| Gyroscope | ✓ | ✗ | real | AVD `hw.gyroscope` |
| Camera | virtual scene | ✗ | real | AVD `hw.camera.back=virtualscene` |
| Microphone | ✓ | ✗ | real | AVD `hw.audioInput` |
| Network type / signal | ✓ | ✗ | real | emulator console `gsm`, not yet surfaced |
| Fingerprint | ✓ | ✗ | real | emulator console `finger touch`, not yet surfaced |

Three notes on the honesty of this table:

**Battery has a fallback chain, and it is worth understanding.** `AvdAdapter`
tries the emulator console first; older emulator builds without the power
console fall through to `dumpsys battery set`, which works on real devices too.
So battery simulation works on all three runtimes, by two different mechanisms,
and the caller never knows which. That is the abstraction doing its job.

But `dumpsys battery set` **latches** — a device left that way keeps reporting
the fake level until `dumpsys battery reset`. A "reset battery to real" action
belongs alongside this and is not yet wired up.

**Fold only works if the device was created foldable.** The emulator's hinge is
declared at AVD creation (`hw.sensor.hinge`, `hw.displayRegion.0.1.*`), not
toggled later. `setFold` on a non-foldable device says exactly that: *"…was not
created as a foldable, so it has nothing to fold."*

**Physical devices have real sensors, and that is a feature.** `setGps` on real
hardware throws rather than pretending, and names the requirement: a
mock-location app installed and selected in developer options. If mock location
is genuinely wanted on the physical fleet, the right shape is a small ProxBox
helper APK the agent installs on request — at which point `PhysicalAdbAdapter`
overrides `setGps` to broadcast to it, and nothing above the runtime changes.

`gsm` (network type, signal strength) and `finger touch` are one-line additions
to `AvdAdapter` and one field each in the sensors endpoint; they are listed here
rather than built because nothing has asked for them yet.
