# ProxBox Android device subsystem

Android as a platform inside The ProxBox, not an Android app bolted onto it.

The unit is a **device**, not a phone. A device is an **OS image** plus a
**hardware profile**, satisfied by a **runtime**, placed on a **node**. A
physical tablet on a USB port is the same concept with the image and hardware
fixed and the runtime being "the thing already on the end of the cable".

Nothing here is a second web app. It is new sections in the ProxBox controller,
API and UI you already have.

---

## The documents

| Document | Covers |
| --- | --- |
| [architecture.md](architecture.md) | Overall subsystem architecture, the `AndroidDevice` abstraction, the runtime adapter architecture, service layout, repository layout |
| [runtimes.md](runtimes.md) | The AVD adapter, the QEMU adapter, the physical ADB adapter, the Waydroid assessment, Android version compatibility, ARM/x86 compatibility, image preparation runbooks |
| [registries.md](registries.md) | Image registry, hardware profile registry, form-factor model, capability model, configuration format, image importing |
| [scheduling.md](scheduling.md) | Node capability detection, the scheduler, physical-device discovery |
| [remote-control.md](remote-control.md) | Remote control architecture, sensor simulation |
| [platform.md](platform.md) | Networking, storage and snapshots, security |
| [api.md](api.md) | REST API, websocket design, database schema, ProxBox UI integration points |
| [node-agent.md](node-agent.md) | Installing and operating the node agent |

---

## What is actually built

Working code, typechecked, exercised end to end offline:

```
server/android/            the subsystem
  types.ts                 the shared vocabulary
  config.ts                every knob, all with inert defaults
  registry.ts              image / profile / form-factor / network registries
  compat.ts                version + architecture compatibility model
  scheduler.ts             the placement pipeline
  store.ts                 device + node registry persistence
  nodes.ts                 heartbeat intake, physical-device discovery
  agent-client.ts          signed controller -> agent calls
  pve.ts                   the small Proxmox client the QEMU adapter needs
  routes.ts                /svc/android/*
  runtime/
    adapter.ts             the AndroidDevice interface
    adb-base.ts            the control surface, written once
    avd.ts                 Google Android Emulator
    qemu.ts                Android VMs on Proxmox
    physical.ts            real hardware over ADB
    mock.ts                no hardware at all, for offline development
    index.ts               runtime manager, boot watcher, reapers
  data/                    the shipped catalogue (JSON, extensible)

agent/
  proxbox-android-agent.mjs    the node agent - stdlib only, no dependencies
  install-android-agent.sh     one-shot installer for a Proxmox node

src/
  android.ts               client API + types
  components/DevicesPanel.tsx    the Devices section
  components/NewDevice.tsx       create device, basic + advanced
  components/DeviceCard.tsx      one device, virtual or physical
  components/DeviceScreen.tsx    remote control
```

Two lines of existing code changed: an import and `app.use(createAndroidRouter({ isSignedIn }))`
in `server/index.ts`, plus the `Devices` button and panel in `Dashboard.tsx`.
Everything else is new files. The subsystem is inert until a node runs the agent.

### Try it with nothing attached

```bash
ANDROID_MOCK=1 npm run serve
```

The mock runtime creates devices with no hardware behind them and serves a real
(if synthetic) screen you can tap, type into, rotate and reshape. It exists so
the controller and UI can be developed without the cluster, and as a standing
check that the abstraction holds: if a UI feature works against the mock and
against a Samsung tablet without branching, the layering is right.

---

## Build order

Each step is independently useful and independently shippable.

1. **Registries and the compatibility model.** Images, profiles, form factors,
   capabilities, the Android version table. No hardware needed. ✅ built
2. **Scheduler and device registry.** Planning answers become real before
   anything can be built. `POST /svc/android/plan` is useful on its own. ✅ built
3. **Mock runtime + UI.** Prove the abstraction and the whole UI flow offline.
   ✅ built
4. **Node agent.** Capability detection and physical discovery. Nodes start
   appearing under Devices. ✅ built
5. **Physical ADB adapter.** Real hardware becomes usable — this is milestone 2,
   and it lands *before* the emulator because it needs no image staging. ✅ built
6. **AVD adapter.** Emulator devices on one node, then several — milestone 1.
   ✅ built, needs the SDK staged on a node to run for real
7. **QEMU adapter.** Bliss/Android-x86/GSI VMs and linked clones. ✅ built,
   needs a base template prepared once — see [runtimes.md](runtimes.md)
8. **Streaming upgrade.** Replace polled screenshots with H.264 over a websocket
   on its own port. Designed, not built — see [remote-control.md](remote-control.md)
9. **Isolated lab networks.** Per-lab VLANs and firewall groups. Designed —
   see [platform.md](platform.md)
10. **Waydroid**, if and only if the density argument wins. See the assessment
    in [runtimes.md](runtimes.md); the recommendation today is no.

## Milestones

**Milestone 1 — the abstraction holds.** Create Android 15 as a 1080×2400 phone
and as a 2560×1600 tablet from the same image, from the existing ProxBox UI, and
then view, control, install an APK, open a shell, reboot, reset and destroy
each one.

Status: the full path works against the mock runtime today (`smoke` output:
same image id backing both shapes, both display specs honoured, control surface
exercised). Against real hardware it needs the Android SDK staged on one node —
step 6 above — which is an install task, not a code task.

**Milestone 2 — physical and virtual become one concept.** An Android device
plugged into any capable node appears in the same registry, on the same cards,
with the same actions.

Status: working. Discovery registers the device, classifies its form factor from
its own reported characteristics, marks it offline when unplugged without
forgetting it, and the scheduler will satisfy an ARM64 request with a real ARM64
tablet rather than refusing.

---

## The one rule

If a caller above the runtime layer ever needs to ask "is this really an
emulator or a real tablet?", the abstraction has failed and the branch belongs
inside an adapter. Everything in this design follows from that.
