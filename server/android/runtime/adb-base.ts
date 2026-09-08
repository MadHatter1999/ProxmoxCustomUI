import { agent } from '../agent-client.js'
import type { Capabilities, DevicePlan, DeviceRecord, Orientation, RuntimeKind } from '../types.js'
import {
  DeviceNotReady,
  UnsupportedByRuntime,
  type AndroidRuntimeAdapter,
  type CreateContext,
  type DeviceStatus,
  type ScreenShot
} from './adapter.js'

/**
 * Everything three of the four runtimes have in common: once Android is up and
 * ADB answers, controlling it is identical whether the OS is running inside
 * Google's emulator, inside a Proxmox VM, or on a tablet in the workshop.
 *
 * So the control surface lives here exactly once, expressed in adb terms, and
 * the concrete adapters below only implement the part that genuinely differs -
 * how the thing comes into existence and how it starts and stops.
 *
 * Every command goes out as an argv array through the node agent. Nothing here
 * ever builds a host shell string, so a package name or filename typed in the
 * UI cannot become a command on a Proxmox node.
 */
export abstract class AdbBackedAdapter implements AndroidRuntimeAdapter {
  abstract readonly kind: RuntimeKind
  abstract readonly name: string
  abstract readonly capabilities: Partial<Capabilities>

  abstract available(): Promise<boolean>
  abstract create(plan: DevicePlan, ctx: CreateContext): Promise<DeviceRecord>
  abstract start(device: DeviceRecord): Promise<void>
  abstract stop(device: DeviceRecord): Promise<void>
  abstract destroy(device: DeviceRecord): Promise<void>
  abstract reset(device: DeviceRecord): Promise<void>

  /** Serial as this device's owning node's adb knows it. */
  protected serial(device: DeviceRecord): string {
    const serial = device.adb.serial
    if (!serial) throw new DeviceNotReady(device, 'this')
    return serial
  }

  protected requireReady(device: DeviceRecord, what: string): void {
    if (device.state !== 'ready') throw new DeviceNotReady(device, what)
  }

  // ---- lifecycle bits that are the same everywhere -------------------------

  async reboot(device: DeviceRecord): Promise<void> {
    await agent.adbOk(device.node, this.serial(device), ['reboot'])
  }

  /**
   * The universal readiness check: sys.boot_completed is the only signal that
   * means Android is actually up. "The VM is running" and "the emulator process
   * exists" both lie constantly.
   */
  async status(device: DeviceRecord): Promise<DeviceStatus> {
    const serial = device.adb.serial
    if (!serial) return { state: device.state, statusText: device.statusText }
    try {
      const out = await agent.adb(device.node, serial, ['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 8000 })
      const booted = out.code === 0 && out.stdout.toString('utf8').trim() === '1'
      if (booted) {
        return { state: 'ready', adb: { serial, reachable: true }, statusText: undefined }
      }
      return { state: 'booting', statusText: 'Android is starting - waiting for boot to complete', adb: { serial, reachable: true } }
    } catch (err) {
      // An unreachable agent is not the same as a dead device: say which.
      return {
        state: device.state === 'ready' ? 'offline' : device.state,
        statusText: err instanceof Error ? err.message : String(err),
        adb: { serial, reachable: false }
      }
    }
  }

  // ---- control surface -----------------------------------------------------

  async shell(device: DeviceRecord, command: string): Promise<string> {
    this.requireReady(device, 'a shell command')
    const r = await agent.adb(device.node, this.serial(device), ['shell', command])
    const out = r.stdout.toString('utf8')
    return r.code === 0 ? out : `${out}${r.stderr}`.trim() || `(exit ${r.code})`
  }

  async installApk(device: DeviceRecord, apk: { name: string; data: Buffer }): Promise<string> {
    this.requireReady(device, 'installing an APK')
    // "@stdin" tells the agent to spool the body to a temp file on the node and
    // substitute its path - adb install needs a real file, and this way the APK
    // never has to be staged anywhere the controller has to clean up.
    return agent.adbOk(device.node, this.serial(device), ['install', '-r', '-g', '@stdin'], {
      stdin: apk.data,
      timeoutMs: 300_000
    })
  }

  async uninstall(device: DeviceRecord, packageName: string): Promise<string> {
    this.requireReady(device, 'uninstalling a package')
    if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error(`"${packageName}" is not a valid package name.`)
    return agent.adbOk(device.node, this.serial(device), ['uninstall', packageName])
  }

  async pushFile(device: DeviceRecord, remotePath: string, data: Buffer): Promise<string> {
    this.requireReady(device, 'pushing a file')
    return agent.adbOk(device.node, this.serial(device), ['push', '@stdin', remotePath], {
      stdin: data,
      timeoutMs: 300_000
    })
  }

  async pullFile(device: DeviceRecord, remotePath: string): Promise<Buffer> {
    this.requireReady(device, 'pulling a file')
    return agent.adbBinary(device.node, this.serial(device), ['exec-out', 'cat', remotePath], 300_000)
  }

  async screenshot(device: DeviceRecord): Promise<ScreenShot> {
    this.requireReady(device, 'a screenshot')
    const png = await agent.adbBinary(device.node, this.serial(device), ['exec-out', 'screencap', '-p'], 20_000)
    return { mime: 'image/png', data: png, width: device.display.width, height: device.display.height }
  }

  /**
   * screenrecord runs on the device itself and is capped, deliberately: a
   * forgotten recording must not be able to fill a device's storage. Three
   * minutes is the ceiling per clip.
   */
  async startRecording(device: DeviceRecord): Promise<string> {
    this.requireReady(device, 'screen recording')
    if (device.capabilities.screen_record === false) throw new UnsupportedByRuntime(this.kind, 'Screen recording')
    const remote = `/sdcard/proxbox-${device.id}.mp4`
    await agent.adb(device.node, this.serial(device), [
      'shell',
      `screenrecord --time-limit 180 --bit-rate 4000000 ${remote} >/dev/null 2>&1 &`
    ])
    return remote
  }

  async stopRecording(device: DeviceRecord): Promise<Buffer> {
    const remote = `/sdcard/proxbox-${device.id}.mp4`
    const serial = this.serial(device)
    // SIGINT, not kill: screenrecord only finalises the MP4 container when it
    // is interrupted politely. A hard kill leaves an unplayable file.
    await agent.adb(device.node, serial, ['shell', 'pkill', '-INT', 'screenrecord'])
    await new Promise(r => setTimeout(r, 1500))
    const data = await agent.adbBinary(device.node, serial, ['exec-out', 'cat', remote], 120_000)
    await agent.adb(device.node, serial, ['shell', 'rm', '-f', remote])
    return data
  }

  async properties(device: DeviceRecord): Promise<Record<string, string>> {
    const raw = await agent.adbOk(device.node, this.serial(device), ['shell', 'getprop'])
    const out: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]\s*$/)
      if (m) out[m[1]] = m[2]
    }
    return out
  }

  // ---- input ---------------------------------------------------------------

  async tap(device: DeviceRecord, x: number, y: number): Promise<void> {
    this.requireReady(device, 'touch input')
    await agent.adb(device.node, this.serial(device), ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
  }

  async swipe(device: DeviceRecord, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
    this.requireReady(device, 'touch input')
    const n = (v: number) => String(Math.round(v))
    await agent.adb(device.node, this.serial(device), ['shell', 'input', 'swipe', n(x1), n(y1), n(x2), n(y2), n(ms)])
  }

  async key(device: DeviceRecord, keycode: string): Promise<void> {
    this.requireReady(device, 'key input')
    if (!/^[A-Z0-9_]+$/.test(keycode)) throw new Error(`"${keycode}" is not a keycode.`)
    await agent.adb(device.node, this.serial(device), ['shell', 'input', 'keyevent', keycode])
  }

  async text(device: DeviceRecord, value: string): Promise<void> {
    this.requireReady(device, 'text input')
    // `input text` takes one token; spaces have to be escaped as %s.
    await agent.adb(device.node, this.serial(device), ['shell', 'input', 'text', value.replace(/ /g, '%s')])
  }

  // ---- shape and sensors ---------------------------------------------------

  async setOrientation(device: DeviceRecord, orientation: Orientation): Promise<void> {
    this.requireReady(device, 'rotation')
    if (device.capabilities.rotation === false) throw new UnsupportedByRuntime(this.kind, 'Rotation')
    const serial = this.serial(device)
    await agent.adb(device.node, serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
    await agent.adb(device.node, serial, [
      'shell', 'settings', 'put', 'system', 'user_rotation', orientation === 'landscape' ? '1' : '0'
    ])
  }

  /**
   * The trick that makes one image serve a phone and a tablet: Android's own
   * display override. `wm size` / `wm density` re-lay-out the whole system UI
   * live, which is exactly what responsive-layout testing needs.
   */
  async setDisplay(device: DeviceRecord, spec: { width?: number; height?: number; dpi?: number }): Promise<void> {
    this.requireReady(device, 'changing the display')
    const serial = this.serial(device)
    if (spec.width && spec.height) {
      await agent.adbOk(device.node, serial, ['shell', 'wm', 'size', `${Math.round(spec.width)}x${Math.round(spec.height)}`])
    }
    if (spec.dpi) {
      await agent.adbOk(device.node, serial, ['shell', 'wm', 'density', String(Math.round(spec.dpi))])
    }
  }

  async setGps(_device: DeviceRecord, _lat: number, _lon: number, _altitude?: number): Promise<void> {
    // Only runtimes with a console channel (the emulator) can inject a fix
    // without an app on the device. Physical/QEMU override or refuse.
    throw new UnsupportedByRuntime(this.kind, 'Setting a GPS position')
  }

  async setBattery(device: DeviceRecord, pct: number, charging: boolean): Promise<void> {
    this.requireReady(device, 'setting battery state')
    const serial = this.serial(device)
    const level = String(Math.max(0, Math.min(100, Math.round(pct))))
    await agent.adbOk(device.node, serial, ['shell', 'dumpsys', 'battery', 'set', 'level', level])
    await agent.adbOk(device.node, serial, ['shell', 'dumpsys', 'battery', 'set', 'ac', charging ? '1' : '0'])
  }

  async setFold(_device: DeviceRecord, _folded: boolean): Promise<void> {
    throw new UnsupportedByRuntime(this.kind, 'Folding')
  }
}
