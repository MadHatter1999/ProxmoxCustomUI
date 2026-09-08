import { agent, AgentError } from '../agent-client.js'
import { store } from '../store.js'
import { newDeviceId, slug } from '../util.js'
import type { Capabilities, DevicePlan, DeviceRecord, RuntimeKind } from '../types.js'
import { AdbBackedAdapter } from './adb-base.js'
import type { CreateContext } from './adapter.js'

/**
 * Google's Android Emulator, driven on a node by the ProxBox agent.
 *
 * This is the runtime that makes the first milestone honest: the AVD's skin is
 * just width/height/DPI, so ONE system image - aosp-15-x86_64 - backs both the
 * 1080x2400 phone and the 2560x1600 tablet. No per-shape image, no per-shape
 * code. Everything odd the lab wants (1920x480 strip display, 454x454 watch)
 * is the same call with different numbers.
 *
 * It is also the only runtime with a side channel to the OS: the emulator
 * console (reached with `adb emu ...`) injects GPS fixes, fold events, battery
 * state and rotation without an agent app on the device. That is why the
 * scheduler prefers it for anything sensor-heavy.
 *
 * Requirements it does NOT hide: x86/x86_64 images only, and KVM. Both are
 * checked in compat.ts before a node is ever considered.
 */
export class AvdAdapter extends AdbBackedAdapter {
  readonly kind: RuntimeKind = 'android-emulator'
  readonly name = 'Google Android Emulator'

  /** What the emulator can do that plain QEMU cannot. */
  readonly capabilities: Partial<Capabilities> = {
    gps: true,
    fold: true,
    rotation: true,
    accelerometer: true,
    gyroscope: true,
    camera_front: true,
    camera_back: true,
    microphone: true,
    speaker: true,
    screen_record: true,
    adb: true,
    root: true,
    // Never emulated by the AVD, whatever an image claims.
    nfc: false,
    bluetooth: false,
    fingerprint: true
  }

  async available(): Promise<boolean> {
    return store.listNodes().some(n => n.reachable && n.runtimes['android-emulator'] === true)
  }

  async create(plan: DevicePlan, ctx: CreateContext): Promise<DeviceRecord> {
    const source = plan.engine.source
    if (source.kind !== 'sdk-package') {
      throw new Error(`${plan.image.name} is not an emulator system image - it cannot run under the AVD runtime.`)
    }
    const id = newDeviceId()
    const name = plan.request.name?.trim() || `${slug(plan.image.name)}-${plan.profile.formFactor}`
    const avdName = `pbx-${id}`

    ctx.progress(`Making sure ${plan.node} has ${source.packageName}`)
    await agent.ensureImage(plan.node, source.packageName)

    ctx.progress(`Creating the ${plan.display.width}x${plan.display.height} @ ${plan.display.dpi}dpi device`)
    await agent.createAvd(plan.node, {
      name: avdName,
      packageName: source.packageName,
      width: plan.display.width,
      height: plan.display.height,
      dpi: plan.display.dpi,
      ramMb: plan.resources.memoryMb,
      cores: plan.resources.cpu,
      storageGb: plan.resources.storageGb,
      characteristic: plan.request.formFactor,
      hardware: this.hardwareProps(plan)
    })

    const device: DeviceRecord = {
      id,
      name,
      platform: 'android',
      kind: 'virtual',
      runtime: this.kind,
      node: plan.node,
      state: 'provisioning',
      statusText: 'Starting the emulator',
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
      adb: { reachable: false },
      backing: { avd: avdName },
      createdBy: ctx.user,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.putDevice(device)

    ctx.progress('Booting Android')
    await this.start(device)
    return store.getDevice(id) ?? device
  }

  /** config.ini properties derived from the profile - sensors, camera, keyboard. */
  private hardwareProps(plan: DevicePlan): Record<string, string> {
    const c = plan.capabilities
    const props: Record<string, string> = {
      'hw.keyboard': c.keyboard ? 'yes' : 'no',
      'hw.dPad': c.dpad ? 'yes' : 'no',
      'hw.gps': c.gps ? 'yes' : 'no',
      'hw.accelerometer': c.accelerometer ? 'yes' : 'no',
      'hw.gyroscope': c.gyroscope ? 'yes' : 'no',
      'hw.audioInput': c.microphone ? 'yes' : 'no',
      'hw.audioOutput': c.speaker ? 'yes' : 'no',
      'hw.camera.back': c.camera_back ? 'virtualscene' : 'none',
      'hw.camera.front': c.camera_front ? 'emulated' : 'none',
      'hw.mainKeys': plan.profile.formFactor === 'tv' ? 'yes' : 'no',
      'hw.lcd.width': String(plan.display.width),
      'hw.lcd.height': String(plan.display.height),
      'hw.lcd.density': String(plan.display.dpi),
      'hw.ramSize': String(plan.resources.memoryMb),
      'hw.cpu.ncore': String(plan.resources.cpu),
      'disk.dataPartition.size': `${plan.resources.storageGb}G`
    }
    if (plan.display.unfolded) {
      // The emulator's own fold support: posture changes only work when the
      // device is declared foldable up front, not toggled later.
      props['hw.displayRegion.0.1.width'] = String(plan.display.unfolded.width)
      props['hw.displayRegion.0.1.height'] = String(plan.display.unfolded.height)
      props['hw.sensor.hinge'] = 'yes'
      props['hw.sensor.hinge.count'] = '1'
      props['hw.sensor.hinge.type'] = '1'
    }
    return props
  }

  async start(device: DeviceRecord): Promise<void> {
    const avd = String(device.backing.avd ?? '')
    if (!avd) throw new Error(`${device.name} has no emulator behind it any more.`)
    const node = store.getNode(device.node)
    const gpu = node?.gpu?.opengl ? 'host' : 'swiftshader_indirect'
    const wipe = device.persistence === 'disposable' && device.state === 'stopped'
    const res = await agent.startAvd(device.node, avd, {
      gpu,
      headless: true,
      wipeData: wipe,
      networkProfile: device.network
    })
    store.patchDevice(device.id, {
      state: 'booting',
      statusText: 'Android is starting',
      adb: { serial: res.serial, reachable: true },
      backing: { ...device.backing, serial: res.serial, consolePort: res.port }
    })
  }

  async stop(device: DeviceRecord): Promise<void> {
    const avd = String(device.backing.avd ?? '')
    if (avd) await agent.stopAvd(device.node, avd).catch(() => {})
    store.patchDevice(device.id, { state: 'stopped', statusText: undefined, adb: { ...device.adb, reachable: false } })
  }

  /** Wipe back to the pristine system image, same device identity. */
  async reset(device: DeviceRecord): Promise<void> {
    await this.stop(device)
    const avd = String(device.backing.avd ?? '')
    const node = store.getNode(device.node)
    await agent.startAvd(device.node, avd, {
      gpu: node?.gpu?.opengl ? 'host' : 'swiftshader_indirect',
      headless: true,
      wipeData: true,
      networkProfile: device.network
    })
    store.patchDevice(device.id, { state: 'booting', statusText: 'Wiped - Android is starting fresh' })
  }

  async destroy(device: DeviceRecord): Promise<void> {
    const avd = String(device.backing.avd ?? '')
    if (!avd) return
    await agent.stopAvd(device.node, avd).catch(() => {})
    await agent.deleteAvd(device.node, avd).catch((err: unknown) => {
      // Losing the AVD directory is not a reason to keep a ghost record around;
      // log it and let the device go.
      console.error(`[android] could not delete AVD ${avd} on ${device.node}:`, err instanceof Error ? err.message : err)
    })
  }

  // ---- the emulator console extras ----------------------------------------

  /** `adb emu` reaches the emulator console without an app on the device. */
  private emu(device: DeviceRecord, args: string[]): Promise<string> {
    return agent.adbOk(device.node, device.adb.serial, ['emu', ...args])
  }

  override async setGps(device: DeviceRecord, lat: number, lon: number, altitude?: number): Promise<void> {
    this.requireReady(device, 'setting a GPS position')
    // Emulator console takes longitude first. Getting this backwards is the
    // classic way to end up testing in the Gulf of Guinea.
    const args = ['geo', 'fix', String(lon), String(lat)]
    if (altitude !== undefined) args.push(String(altitude))
    await this.emu(device, args)
  }

  override async setFold(device: DeviceRecord, folded: boolean): Promise<void> {
    this.requireReady(device, 'folding')
    if (!device.display.unfolded) {
      throw new Error(`${device.name} was not created as a foldable, so it has nothing to fold.`)
    }
    await this.emu(device, [folded ? 'fold' : 'unfold'])
  }

  override async setBattery(device: DeviceRecord, pct: number, charging: boolean): Promise<void> {
    this.requireReady(device, 'setting battery state')
    try {
      await this.emu(device, ['power', 'capacity', String(Math.round(pct))])
      await this.emu(device, ['power', 'ac', charging ? 'on' : 'off'])
    } catch (err) {
      if (err instanceof AgentError) {
        // Older emulator builds without the power console still honour dumpsys.
        await super.setBattery(device, pct, charging)
        return
      }
      throw err
    }
  }
}
