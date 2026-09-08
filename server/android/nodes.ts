import { NO_CAPABILITIES, type Arch, type Capabilities, type DeviceRecord, type NodeCapabilities, type Orientation, type PhysicalDeviceReport } from './types.js'
import { store } from './store.js'
import { formFactor as getFormFactor } from './registry.js'

/**
 * Node capability intake and physical-device discovery.
 *
 * Every agent heartbeat lands here. Two things happen: the node's own facts are
 * recorded (so the scheduler knows which machines have KVM, a GPU, USB host
 * ports and which runtimes are installed), and whatever Android hardware is
 * plugged into it is reconciled into the SAME device registry the virtual
 * devices live in.
 *
 * That reconciliation is the whole point of milestone 2: after this function
 * runs, a Samsung tablet on pve6 and an emulator on pve3 are two rows in one
 * table, and everything above this layer stops being able to tell them apart.
 */

export interface HeartbeatBody {
  node: string
  agentVersion: string
  endpoint?: string
  arch?: Arch
  cpuModel?: string
  cpuGeneration?: string
  cores?: number
  ramMb?: number
  freeRamMb?: number
  storageFreeGb?: number
  kvm?: boolean
  nestedKvm?: boolean
  vtx?: boolean
  svm?: boolean
  gpu?: NodeCapabilities['gpu']
  runtimes?: Record<string, boolean>
  usbHost?: boolean
  usbip?: boolean
  adbVersion?: string
  scrcpyVersion?: string
  cachedImages?: string[]
  devices?: PhysicalDeviceReport[]
}

export function recordHeartbeat(body: HeartbeatBody): NodeCapabilities {
  const caps: NodeCapabilities = {
    node: body.node,
    agentVersion: body.agentVersion ?? '0',
    lastSeen: Date.now(),
    reachable: true,
    arch: body.arch ?? 'x86_64',
    cpuModel: body.cpuModel,
    cpuGeneration: body.cpuGeneration,
    cores: body.cores ?? 0,
    ramMb: body.ramMb ?? 0,
    freeRamMb: body.freeRamMb ?? 0,
    storageFreeGb: body.storageFreeGb,
    kvm: !!body.kvm,
    nestedKvm: !!body.nestedKvm,
    vtx: !!body.vtx,
    svm: !!body.svm,
    gpu: body.gpu,
    runtimes: body.runtimes ?? {},
    usbHost: !!body.usbHost,
    usbip: !!body.usbip,
    adbVersion: body.adbVersion,
    scrcpyVersion: body.scrcpyVersion,
    cachedImages: body.cachedImages ?? [],
    physical: body.devices ?? [],
    endpoint: body.endpoint
  }
  store.putNode(caps)
  reconcilePhysical(caps)
  return caps
}

/** Devices this node reports vs devices we have registered for it. */
function reconcilePhysical(node: NodeCapabilities): void {
  const registered = store.listDevices().filter(d => d.kind === 'physical' && d.node === node.node)
  const seen = new Set<string>()

  for (const report of node.physical) {
    seen.add(report.serial)
    const existing = registered.find(d => d.adb.serial === report.serial)
    if (existing) {
      updateFromReport(existing, report)
    } else {
      store.putDevice(deviceFromReport(node.node, report))
      store.audit({
        at: Date.now(),
        user: 'system',
        action: 'device.discover',
        detail: `${report.manufacturer ?? ''} ${report.model ?? report.serial} on ${node.node}`.trim(),
        ok: true
      })
    }
  }

  // Anything we know about that the node no longer sees has been unplugged.
  for (const d of registered) {
    if (d.adb.serial && seen.has(d.adb.serial)) continue
    if (d.state === 'offline') continue
    store.patchDevice(d.id, {
      state: 'offline',
      statusText: 'Unplugged, or no longer answering ADB on this node',
      adb: { ...d.adb, reachable: false }
    })
  }
}

function updateFromReport(device: DeviceRecord, report: PhysicalDeviceReport): void {
  const online = report.state === 'device'
  const patch: Partial<DeviceRecord> = {
    state: online ? (device.state === 'offline' || device.state === 'provisioning' ? 'ready' : device.state) : 'offline',
    statusText: online
      ? report.state === 'device' && device.statusText === 'Unplugged, or no longer answering ADB on this node'
        ? undefined
        : device.statusText
      : `ADB reports it as "${report.state}"`,
    adb: { serial: report.serial, endpoint: report.connection === 'tcp' ? report.serial : undefined, reachable: online },
    backing: {
      ...device.backing,
      connection: report.connection,
      battery: report.batteryPct,
      charging: report.charging ? 1 : 0,
      usbVid: report.usbVid,
      usbPid: report.usbPid
    }
  }
  // A device that was re-flashed or updated should not keep stale facts.
  if (report.androidVersion && report.androidVersion !== device.androidVersion) {
    patch.androidVersion = report.androidVersion
    patch.apiLevel = report.apiLevel ?? device.apiLevel
  }
  if (report.display && report.display.width && report.display.height) {
    patch.display = {
      ...device.display,
      width: report.display.width,
      height: report.display.height,
      dpi: report.display.dpi || device.display.dpi,
      orientation: report.display.orientation ?? device.display.orientation
    }
  }
  store.patchDevice(device.id, patch)
}

function deviceFromReport(node: string, report: PhysicalDeviceReport): DeviceRecord {
  const display = {
    width: report.display?.width ?? 1080,
    height: report.display?.height ?? 1920,
    dpi: report.display?.dpi ?? 320,
    orientation: (report.display?.orientation ?? 'portrait') as Orientation
  }
  const ffId = inferFormFactor(report, display)
  const ff = getFormFactor(ffId)
  const capabilities: Capabilities = {
    ...NO_CAPABILITIES,
    ...(ff?.capabilities ?? {}),
    // A real device has real hardware. What we can be sure of from ADB alone is
    // that it has a screen, takes input and speaks ADB; the rest comes from the
    // form factor's shape and can be corrected by an admin per device.
    touch: true,
    multitouch: true,
    adb: true,
    screen_record: (report.apiLevel ?? 0) >= 19,
    rotation: ffId !== 'tv' && ffId !== 'kiosk',
    // Simulated sensors are meaningless here: these are the real ones.
    gps: false,
    fold: false
  }

  const name = [report.manufacturer, report.model].filter(Boolean).join(' ') || report.serial

  return {
    // Physical ids are derived from the serial, so unplugging and replugging a
    // device gives back the same registry row rather than a duplicate.
    id: `phy-${hash(report.serial)}`,
    name,
    platform: 'android',
    kind: 'physical',
    runtime: 'physical-adb',
    node,
    state: report.state === 'device' ? 'ready' : 'offline',
    statusText: report.state === 'unauthorized' ? 'Waiting for someone to tap "Allow USB debugging" on the device' : undefined,
    imageId: 'physical-device',
    imageName: `${report.manufacturer ?? 'Android'} ${report.androidVersion ?? ''}`.trim(),
    androidVersion: report.androidVersion ?? 'unknown',
    apiLevel: report.apiLevel ?? 0,
    architecture: report.arch ?? 'arm64',
    formFactor: ffId,
    display,
    resources: {
      cpu: 0, // a real device's cores are its own business
      memoryMb: report.ramMb ?? 0,
      storageGb: report.storageGb ?? 0
    },
    capabilities,
    persistence: 'persistent',
    network: 'lan',
    reservation: null,
    adb: { serial: report.serial, endpoint: report.connection === 'tcp' ? report.serial : undefined, reachable: report.state === 'device' },
    backing: {
      connection: report.connection,
      usbVid: report.usbVid,
      usbPid: report.usbPid,
      battery: report.batteryPct,
      charging: report.charging ? 1 : 0,
      // Wiping real hardware is opt-in, per device, by an admin. Never default.
      wipeable: 0
    },
    createdBy: 'discovery',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/**
 * What kind of thing is this?
 *
 * Android tells us directly when it can (ro.build.characteristics), and when it
 * cannot we use the same rule Android itself uses for layout: smallest width in
 * dp. 600dp is the tablet boundary, which is why a 1200x1920 @320dpi panel is a
 * tablet and a 1080x2340 @420dpi one is a phone.
 */
function inferFormFactor(report: PhysicalDeviceReport, display: { width: number; height: number; dpi: number }): string {
  const c = (report.characteristics ?? '').toLowerCase()
  if (c.includes('watch')) return 'wear'
  if (c.includes('automotive')) return 'automotive'
  if (c.includes('tv')) return 'tv'
  if (c.includes('tablet')) return 'tablet_large'
  const model = (report.model ?? '').toLowerCase()
  if (/tc\d{2}|scanner|rugged|handheld/.test(model)) return 'phone'
  if (/pos|terminal/.test(model)) return 'pos'
  const smallestDp = (Math.min(display.width, display.height) / (display.dpi || 160)) * 160
  if (smallestDp >= 720) return 'tablet_large'
  if (smallestDp >= 600) return 'tablet_small'
  return 'phone'
}

/** Stable short id from a serial - not security, just a tidy key. */
function hash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36).slice(0, 8)
}
