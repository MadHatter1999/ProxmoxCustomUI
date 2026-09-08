import { store } from '../store.js'
import { newDeviceId } from '../util.js'
import type { Capabilities, DevicePlan, DeviceRecord, Orientation, RuntimeKind } from '../types.js'
import type { AndroidRuntimeAdapter, CreateContext, DeviceStatus, ScreenShot } from './adapter.js'

/**
 * A device with nothing behind it.
 *
 * This exists so the entire controller path - plan, schedule, create, boot,
 * ADB, screen, input, install, reset, destroy - can be developed and demoed
 * without a node agent, without an emulator, and above all without touching
 * the cluster. Turn it on with ANDROID_MOCK=1; it is invisible otherwise.
 *
 * It is also the cheapest possible check that the abstraction holds: if a UI
 * feature works against the mock and against a real tablet without branching,
 * the layering is right.
 */
export class MockAdapter implements AndroidRuntimeAdapter {
  readonly kind: RuntimeKind = 'mock'
  readonly name = 'Mock device (no hardware)'
  readonly capabilities: Partial<Capabilities> = {
    touch: true, multitouch: true, keyboard: true, mouse: true, rotation: true,
    accelerometer: true, gyroscope: true, gps: true, adb: true, screen_record: true,
    fold: true, nfc: false, bluetooth: false
  }

  /** Purely visual state so the fake screen reacts to input. */
  private screens = new Map<string, { taps: Array<{ x: number; y: number; at: number }>; text: string[]; folded: boolean }>()

  async available(): Promise<boolean> {
    return true
  }

  async create(plan: DevicePlan, ctx: CreateContext): Promise<DeviceRecord> {
    const id = newDeviceId()
    ctx.progress('Creating a mock device')
    const device: DeviceRecord = {
      id,
      name: plan.request.name?.trim() || `mock-${plan.profile.formFactor}`,
      platform: 'android',
      kind: 'virtual',
      runtime: this.kind,
      node: plan.node,
      state: 'booting',
      statusText: 'Pretending to boot',
      imageId: plan.image.id,
      imageName: plan.image.name,
      androidVersion: plan.image.androidVersion,
      apiLevel: plan.image.apiLevel,
      architecture: plan.image.architecture,
      formFactor: plan.profile.formFactor,
      hardwareProfileId: plan.profile.id,
      display: plan.display,
      resources: plan.resources,
      capabilities: plan.capabilities,
      persistence: plan.persistence,
      network: plan.network.id,
      reservation: { owner: ctx.user, since: Date.now() },
      adb: { serial: `mock-${id}`, reachable: true },
      backing: { bootAt: Date.now() + 4000 },
      createdBy: ctx.user,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.screens.set(id, { taps: [], text: [], folded: false })
    store.putDevice(device)
    return device
  }

  async start(device: DeviceRecord): Promise<void> {
    store.patchDevice(device.id, { state: 'booting', statusText: 'Pretending to boot', backing: { ...device.backing, bootAt: Date.now() + 4000 } })
  }

  async stop(device: DeviceRecord): Promise<void> {
    store.patchDevice(device.id, { state: 'stopped', statusText: undefined })
  }

  async reboot(device: DeviceRecord): Promise<void> {
    await this.start(device)
  }

  async reset(device: DeviceRecord): Promise<void> {
    this.screens.set(device.id, { taps: [], text: [], folded: false })
    await this.start(device)
  }

  async destroy(device: DeviceRecord): Promise<void> {
    this.screens.delete(device.id)
  }

  async status(device: DeviceRecord): Promise<DeviceStatus> {
    if (device.state === 'stopped') return { state: 'stopped' }
    const bootAt = Number(device.backing.bootAt ?? 0)
    if (Date.now() < bootAt) return { state: 'booting', statusText: 'Pretending to boot' }
    return { state: 'ready', adb: { serial: device.adb.serial, reachable: true } }
  }

  async shell(device: DeviceRecord, command: string): Promise<string> {
    if (command.startsWith('getprop')) return this.propText(device)
    if (command.startsWith('pm list packages')) return 'package:com.android.settings\npackage:com.example.underTest\n'
    return `mock:/ $ ${command}\n(nothing actually ran - this is a mock device)\n`
  }

  async installApk(_device: DeviceRecord, apk: { name: string; data: Buffer }): Promise<string> {
    return `Success (mock install of ${apk.name}, ${apk.data.length} bytes)`
  }

  async uninstall(_device: DeviceRecord, packageName: string): Promise<string> {
    return `Success (mock uninstall of ${packageName})`
  }

  async pushFile(_device: DeviceRecord, remotePath: string, data: Buffer): Promise<string> {
    return `${data.length} bytes pushed to ${remotePath} (mock)`
  }

  async pullFile(_device: DeviceRecord, remotePath: string): Promise<Buffer> {
    return Buffer.from(`mock contents of ${remotePath}\n`)
  }

  /**
   * An SVG screen, so the remote-control UI has something real to render and
   * click on with no image libraries anywhere in the stack. Taps land, text
   * appears, rotation and fold change the shape - enough to prove the control
   * path end to end.
   */
  async screenshot(device: DeviceRecord): Promise<ScreenShot> {
    const s = this.screens.get(device.id) ?? { taps: [], text: [], folded: false }
    const d = device.display
    const w = s.folded && d.unfolded ? d.unfolded.width : d.width
    const h = s.folded && d.unfolded ? d.unfolded.height : d.height
    const now = Date.now()
    const dots = s.taps
      .filter(t => now - t.at < 1500)
      .map(t => `<circle cx="${t.x}" cy="${t.y}" r="${Math.max(18, w / 40)}" fill="none" stroke="#6ee7b7" stroke-width="4" opacity="0.8"/>`)
      .join('')
    const lines = s.text
      .slice(-8)
      .map((t, i) => `<text x="${w * 0.08}" y="${h * 0.55 + i * (h * 0.045)}" font-family="monospace" font-size="${Math.max(12, w / 34)}" fill="#a7f3d0">${escapeXml(t)}</text>`)
      .join('')
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="100%" height="100%" fill="#0d1117"/>` +
      `<rect x="0" y="0" width="100%" height="${Math.max(28, h / 26)}" fill="#161b22"/>` +
      `<text x="${w * 0.03}" y="${Math.max(20, h / 34)}" font-family="sans-serif" font-size="${Math.max(11, w / 60)}" fill="#8b949e">${escapeXml(device.name)}</text>` +
      `<text x="${w * 0.72}" y="${Math.max(20, h / 34)}" font-family="sans-serif" font-size="${Math.max(11, w / 60)}" fill="#8b949e">${new Date().toLocaleTimeString()}</text>` +
      `<text x="50%" y="${h * 0.36}" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(20, w / 18)}" fill="#e6edf3">Android ${escapeXml(device.androidVersion)}</text>` +
      `<text x="50%" y="${h * 0.43}" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(12, w / 40)}" fill="#8b949e">${w} x ${h} @ ${d.dpi} dpi - ${escapeXml(device.formFactor)}</text>` +
      `${lines}${dots}</svg>`
    return { mime: 'image/svg+xml', data: Buffer.from(svg), width: w, height: h }
  }

  async startRecording(): Promise<string> {
    return '/sdcard/mock.mp4'
  }

  async stopRecording(): Promise<Buffer> {
    return Buffer.from('')
  }

  async properties(device: DeviceRecord): Promise<Record<string, string>> {
    return {
      'ro.build.version.release': device.androidVersion,
      'ro.build.version.sdk': String(device.apiLevel),
      'ro.product.cpu.abi': device.architecture,
      'ro.product.model': device.name,
      'ro.build.characteristics': device.formFactor,
      'proxbox.mock': '1'
    }
  }

  private propText(device: DeviceRecord): string {
    return [
      `[ro.build.version.release]: [${device.androidVersion}]`,
      `[ro.build.version.sdk]: [${device.apiLevel}]`,
      `[ro.product.model]: [${device.name}]`,
      '[proxbox.mock]: [1]'
    ].join('\n')
  }

  async tap(device: DeviceRecord, x: number, y: number): Promise<void> {
    const s = this.screens.get(device.id)
    if (s) s.taps.push({ x, y, at: Date.now() })
  }

  async swipe(device: DeviceRecord, _x1: number, _y1: number, x2: number, y2: number): Promise<void> {
    await this.tap(device, x2, y2)
  }

  async key(device: DeviceRecord, keycode: string): Promise<void> {
    this.screens.get(device.id)?.text.push(`key: ${keycode}`)
  }

  async text(device: DeviceRecord, value: string): Promise<void> {
    this.screens.get(device.id)?.text.push(value)
  }

  async setOrientation(device: DeviceRecord, orientation: Orientation): Promise<void> {
    const d = device.display
    const landscape = orientation === 'landscape'
    const wide = d.width > d.height
    if (landscape !== wide) {
      store.patchDevice(device.id, { display: { ...d, width: d.height, height: d.width, orientation } })
    } else {
      store.patchDevice(device.id, { display: { ...d, orientation } })
    }
  }

  async setDisplay(device: DeviceRecord, spec: { width?: number; height?: number; dpi?: number }): Promise<void> {
    store.patchDevice(device.id, { display: { ...device.display, ...spec } })
  }

  async setGps(device: DeviceRecord, lat: number, lon: number): Promise<void> {
    this.screens.get(device.id)?.text.push(`gps: ${lat.toFixed(4)}, ${lon.toFixed(4)}`)
  }

  async setBattery(device: DeviceRecord, pct: number, charging: boolean): Promise<void> {
    this.screens.get(device.id)?.text.push(`battery: ${Math.round(pct)}%${charging ? ' charging' : ''}`)
  }

  async setFold(device: DeviceRecord, folded: boolean): Promise<void> {
    const s = this.screens.get(device.id)
    if (s) s.folded = folded
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}
