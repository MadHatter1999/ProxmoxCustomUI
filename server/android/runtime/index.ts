import { androidConfig } from '../config.js'
import { store } from '../store.js'
import type { DevicePlan, DeviceRecord, RuntimeKind } from '../types.js'
import type { AndroidRuntimeAdapter, CreateContext } from './adapter.js'
import { AvdAdapter } from './avd.js'
import { MockAdapter } from './mock.js'
import { PhysicalAdbAdapter } from './physical.js'
import { QemuAndroidAdapter } from './qemu.js'

/**
 * The runtime manager: one place that knows which implementations exist, and
 * the only place that owns the boot/expiry background work.
 *
 * Adding a runtime is a registration, not a change to anything above. Waydroid
 * would slot in here as one more `register(new WaydroidAdapter())` - see
 * docs/android/runtimes.md for why it is not shipped yet.
 */
class RuntimeManager {
  private adapters = new Map<RuntimeKind, AndroidRuntimeAdapter>()
  private watcher: NodeJS.Timeout | null = null

  constructor() {
    this.register(new AvdAdapter())
    this.register(new QemuAndroidAdapter())
    this.register(new PhysicalAdbAdapter())
    if (androidConfig.mock) this.register(new MockAdapter())
  }

  register(adapter: AndroidRuntimeAdapter): void {
    this.adapters.set(adapter.kind, adapter)
  }

  kinds(): RuntimeKind[] {
    return [...this.adapters.keys()]
  }

  get(kind: RuntimeKind): AndroidRuntimeAdapter {
    const a = this.adapters.get(kind)
    if (!a) throw new Error(`No Android runtime called "${kind}" is registered on this controller.`)
    return a
  }

  for(device: DeviceRecord): AndroidRuntimeAdapter {
    return this.get(device.runtime)
  }

  /**
   * Build a device from a plan. Returns as soon as the device record exists -
   * booting is watched in the background, because a person should see the card
   * appear immediately and then watch it come up, not stare at a spinner.
   */
  async create(plan: DevicePlan, user: string): Promise<DeviceRecord> {
    const adapter = this.get(plan.engine.runtime)
    const progress: string[] = []
    const ctx: CreateContext = {
      user,
      progress: text => {
        progress.push(text)
        console.log(`[android] ${text}`)
      }
    }
    try {
      const device = await adapter.create(plan, ctx)
      store.audit({
        at: Date.now(),
        user,
        action: 'device.create',
        deviceId: device.id,
        detail: `${plan.image.id} as ${plan.profile.id} on ${plan.node} via ${plan.engine.runtime}`,
        ok: true
      })
      this.ensureWatcher()
      return device
    } catch (err) {
      store.audit({
        at: Date.now(),
        user,
        action: 'device.create',
        detail: `${plan.image.id} on ${plan.node}: ${err instanceof Error ? err.message : String(err)}`,
        ok: false
      })
      throw err
    }
  }

  // ---- background work -----------------------------------------------------

  /**
   * One timer for everything: poll devices that are mid-flight, expire held
   * reservations, and bin disposables that have outlived their welcome.
   * Started lazily so a controller with no Android devices does no work at all.
   */
  ensureWatcher(): void {
    if (this.watcher) return
    this.watcher = setInterval(() => {
      this.tick().catch(err => console.error('[android] watcher tick failed:', err))
    }, 5000)
    this.watcher.unref?.()
  }

  private async tick(): Promise<void> {
    const devices = store.listDevices()
    if (!devices.length) return

    await Promise.all(devices.map(d => this.pollOne(d).catch(() => {})))
    this.reapReservations(devices)
    await this.reapDisposables(devices)
  }

  private async pollOne(device: DeviceRecord): Promise<void> {
    // Terminal-ish states do not need polling; physical devices always do,
    // because "offline" has to be able to become "ready" again by itself.
    const active = device.state === 'provisioning' || device.state === 'booting' || device.state === 'ready' || device.state === 'offline'
    if (!active) return
    if (device.state === 'deleting') return

    const adapter = this.adapters.get(device.runtime)
    if (!adapter) return
    const before = device.state
    const status = await adapter.status(device)
    if (status.state === before && status.statusText === device.statusText && !status.adb) return

    const patch: Partial<DeviceRecord> = {
      state: status.state,
      statusText: status.statusText,
      error: status.error
    }
    if (status.adb) patch.adb = { ...device.adb, ...status.adb }
    if (status.state === 'ready' && before !== 'ready') {
      patch.bootedAt = Date.now()
    }
    const updated = store.patchDevice(device.id, patch)

    // First time it reaches ready: make the device actually look like what was
    // asked for. QEMU boots at whatever the image's kernel line said, and a
    // physical tablet boots at its own native size.
    if (updated && status.state === 'ready' && before !== 'ready') {
      await this.applyRequestedShape(updated, adapter)
    }

    // Provisioning timeout: a device that never boots must not sit "booting"
    // forever with nobody told why.
    if (
      updated &&
      (updated.state === 'booting' || updated.state === 'provisioning') &&
      Date.now() - updated.createdAt > androidConfig.bootTimeoutMs &&
      updated.backing.install !== 1
    ) {
      store.patchDevice(device.id, {
        state: 'error',
        error: `Android did not finish booting within ${Math.round(androidConfig.bootTimeoutMs / 60000)} minutes. The device is still there - open its screen to see where it got stuck, or destroy it and try another node.`
      })
    }
  }

  private async applyRequestedShape(device: DeviceRecord, adapter: AndroidRuntimeAdapter): Promise<void> {
    try {
      await adapter.setDisplay(device, device.display)
      await adapter.setOrientation(device, device.display.orientation)
    } catch (err) {
      // Not fatal: the device works, it is just not the exact shape asked for.
      store.patchDevice(device.id, {
        statusText: `Running, but the requested ${device.display.width}x${device.display.height} could not be applied: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  private reapReservations(devices: DeviceRecord[]): void {
    const now = Date.now()
    for (const d of devices) {
      const r = d.reservation
      if (!r) continue
      const expiry = r.expiresAt ?? r.since + androidConfig.reservationTtlMs
      if (now < expiry) continue
      store.patchDevice(d.id, { reservation: null })
      store.audit({ at: now, user: 'system', action: 'reservation.expire', deviceId: d.id, detail: `held by ${r.owner}`, ok: true })
    }
  }

  /** Disposable devices are cheap on purpose - and must not accumulate. */
  private async reapDisposables(devices: DeviceRecord[]): Promise<void> {
    const now = Date.now()
    for (const d of devices) {
      if (d.kind !== 'virtual' || d.persistence !== 'disposable') continue
      if (now - d.createdAt < androidConfig.disposableMaxAgeMs) continue
      if (d.reservation) continue // somebody is still using it - leave it alone
      try {
        await this.destroy(d, 'system')
      } catch (err) {
        console.error(`[android] could not auto-remove disposable ${d.id}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  /** Shared teardown so the reaper and the API agree on what "destroy" means. */
  async destroy(device: DeviceRecord, user: string): Promise<void> {
    store.patchDevice(device.id, { state: 'deleting', statusText: 'Removing' })
    try {
      await this.for(device).destroy(device)
      store.deleteDevice(device.id)
      store.audit({ at: Date.now(), user, action: 'device.destroy', deviceId: device.id, detail: device.name, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.patchDevice(device.id, { state: 'error', error: `Could not remove it: ${message}` })
      store.audit({ at: Date.now(), user, action: 'device.destroy', deviceId: device.id, detail: message, ok: false })
      throw err
    }
  }
}

export const runtimes = new RuntimeManager()
