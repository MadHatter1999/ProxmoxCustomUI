import type {
  Capabilities,
  DevicePlan,
  DeviceRecord,
  DeviceState,
  Orientation,
  RuntimeKind
} from '../types.js'

/**
 * The one interface everything above the runtime layer talks to.
 *
 * Higher-level ProxBox code - the API, the scheduler, the UI - must never need
 * to know whether it is holding Google's emulator, a full Android VM, or a
 * Samsung tablet on the end of a USB cable. If a method here starts needing an
 * "if this is a physical device" branch in a caller, the abstraction is wrong
 * and the branch belongs in the adapter.
 *
 * Two deliberate shapes:
 *  - Lifecycle methods are allowed to be slow and are always idempotent.
 *  - Control methods assume the device is 'ready' and throw a plain Error with
 *    a human sentence if it is not.
 */

export interface ScreenShot {
  mime: string
  data: Buffer
  width?: number
  height?: number
}

export interface DeviceStatus {
  state: DeviceState
  statusText?: string
  adb?: { serial?: string; endpoint?: string; reachable: boolean }
  error?: string
}

export interface CreateContext {
  /** Who asked. Ends up in the audit log and on the device record. */
  user: string
  /** Called as provisioning progresses, so the UI can narrate it honestly. */
  progress: (text: string) => void
}

export interface AndroidRuntimeAdapter {
  readonly kind: RuntimeKind
  readonly name: string

  /**
   * What this runtime can honour at all, independent of image or profile.
   * A `false` here overrides everything below it: the AVD runtime can inject a
   * fold event, plain QEMU cannot, and no image metadata changes that.
   */
  readonly capabilities: Partial<Capabilities>

  /** Is this runtime usable right now (binaries installed, agent reachable)? */
  available(): Promise<boolean>

  // ---- lifecycle -----------------------------------------------------------

  /** Provision the device. Returns the record in 'provisioning' or 'booting'. */
  create(plan: DevicePlan, ctx: CreateContext): Promise<DeviceRecord>
  start(device: DeviceRecord): Promise<void>
  stop(device: DeviceRecord): Promise<void>
  reboot(device: DeviceRecord): Promise<void>
  /** Back to the base image, keeping the same device identity. */
  reset(device: DeviceRecord): Promise<void>
  /** Gone for good. Must succeed even if the device is already half-missing. */
  destroy(device: DeviceRecord): Promise<void>
  /** Cheap poll: is it up, is ADB answering, what changed? */
  status(device: DeviceRecord): Promise<DeviceStatus>

  // ---- control surface -----------------------------------------------------

  shell(device: DeviceRecord, command: string): Promise<string>
  installApk(device: DeviceRecord, apk: { name: string; data: Buffer }): Promise<string>
  uninstall(device: DeviceRecord, packageName: string): Promise<string>
  pushFile(device: DeviceRecord, remotePath: string, data: Buffer): Promise<string>
  pullFile(device: DeviceRecord, remotePath: string): Promise<Buffer>
  screenshot(device: DeviceRecord): Promise<ScreenShot>
  startRecording(device: DeviceRecord): Promise<string>
  stopRecording(device: DeviceRecord): Promise<Buffer>
  properties(device: DeviceRecord): Promise<Record<string, string>>

  // ---- input ---------------------------------------------------------------

  tap(device: DeviceRecord, x: number, y: number): Promise<void>
  swipe(device: DeviceRecord, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>
  key(device: DeviceRecord, keycode: string): Promise<void>
  text(device: DeviceRecord, value: string): Promise<void>

  // ---- device shape and sensors -------------------------------------------

  setOrientation(device: DeviceRecord, orientation: Orientation): Promise<void>
  /** Live resize where the runtime supports it; a no-op-with-warning where not. */
  setDisplay(device: DeviceRecord, spec: { width?: number; height?: number; dpi?: number }): Promise<void>
  setGps(device: DeviceRecord, lat: number, lon: number, altitude?: number): Promise<void>
  setBattery(device: DeviceRecord, pct: number, charging: boolean): Promise<void>
  /** Foldables only; adapters that cannot fold say so rather than silently pass. */
  setFold(device: DeviceRecord, folded: boolean): Promise<void>
}

/** Thrown when a control call is made against something that cannot do it. */
export class UnsupportedByRuntime extends Error {
  constructor(runtime: string, what: string) {
    super(`${what} is not something the ${runtime} runtime can do on this device.`)
  }
}

/** Thrown when the device is not in a state where a call makes sense. */
export class DeviceNotReady extends Error {
  constructor(device: DeviceRecord, what: string) {
    super(`${device.name} is ${device.state}${device.statusText ? ` (${device.statusText})` : ''} - ${what} needs it to be ready.`)
  }
}
