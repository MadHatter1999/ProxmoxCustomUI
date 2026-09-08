import { agent } from '../agent-client.js'
import { store } from '../store.js'
import type { Capabilities, DevicePlan, DeviceRecord, RuntimeKind } from '../types.js'
import { AdbBackedAdapter } from './adb-base.js'
import type { CreateContext, DeviceStatus } from './adapter.js'
import { UnsupportedByRuntime } from './adapter.js'

/**
 * Real Android hardware plugged into a node: phones, tablets, POS terminals,
 * rugged handhelds, TV boxes - anything that answers ADB over USB or TCP.
 *
 * The important thing this adapter proves is that "create a device" and "claim
 * a device" are the same operation from the outside. A physical tablet is not
 * created, it is reserved; everything after that - shell, install, screenshot,
 * input, rotate, record - is the identical code path the virtual devices use,
 * because it is all just adb.
 *
 * What genuinely differs is honesty about limits:
 *  - No sensor injection. A real device's GPS is its GPS.
 *  - Wiping is refused unless the device was registered as wipeable. Nobody
 *    should be able to factory-reset the workshop's only Zebra scanner from a
 *    web page by accident.
 *  - "Stop" does not exist. The device is on. The most we do is lock it.
 */
export class PhysicalAdbAdapter extends AdbBackedAdapter {
  readonly kind: RuntimeKind = 'physical-adb'
  readonly name = 'Physical device (ADB)'

  /**
   * A real device has whatever hardware it has - discovery fills that in per
   * device. What is stated here is only what the RUNTIME can and cannot do.
   */
  readonly capabilities: Partial<Capabilities> = {
    adb: true,
    screen_record: true,
    // Simulated sensors are not a thing on real hardware.
    gps: false,
    fold: false
  }

  async available(): Promise<boolean> {
    return store.listNodes().some(n => n.reachable && n.physical.length > 0)
  }

  /** "Create" a physical device = claim one the scheduler already picked. */
  async create(plan: DevicePlan, ctx: CreateContext): Promise<DeviceRecord> {
    const id = plan.claimDeviceId
    if (!id) throw new Error('No physical device was selected - that is a scheduler bug, not your fault.')
    const device = store.getDevice(id)
    if (!device) throw new Error('That device is no longer registered - it may have been unplugged.')
    if (device.reservation && device.reservation.owner !== ctx.user) {
      throw new Error(`${device.name} is already in use by ${device.reservation.owner}.`)
    }
    ctx.progress(`Reserving ${device.name} on ${device.node}`)
    const claimed = store.patchDevice(id, {
      reservation: { owner: ctx.user, since: Date.now() },
      // A claim may reshape the device: a 10" tablet asked to behave like a
      // phone gets wm size/density applied, exactly like a virtual one.
      display: plan.request.display || plan.request.hardwareProfile ? plan.display : device.display,
      statusText: undefined
    })
    const out = claimed ?? device
    if (out.state === 'ready' && (plan.request.display || plan.request.hardwareProfile)) {
      await this.setDisplay(out, plan.display).catch(() => {
        /* a locked-down device may refuse wm size; not fatal to the claim */
      })
    }
    return out
  }

  /** Nothing to power on - the most useful equivalent is waking the screen. */
  async start(device: DeviceRecord): Promise<void> {
    await agent.adb(device.node, device.adb.serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']).catch(() => {})
  }

  /** Nor off. Lock the screen and release the hold; the hardware stays put. */
  async stop(device: DeviceRecord): Promise<void> {
    await agent.adb(device.node, device.adb.serial, ['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']).catch(() => {})
    store.patchDevice(device.id, { statusText: 'Screen locked - the device itself stays powered' })
  }

  async reset(device: DeviceRecord): Promise<void> {
    if (device.backing.wipeable !== 1) {
      throw new Error(
        `${device.name} is not marked as wipeable, so ProxBox will not factory-reset it. ` +
        'An admin can allow it per device - deliberately, because this is not undoable.'
      )
    }
    await agent.adbOk(device.node, this.serial(device), ['shell', 'recovery', '--wipe_data'])
    store.patchDevice(device.id, { state: 'booting', statusText: 'Factory reset in progress' })
  }

  /** Unregister only. Nothing is done to the hardware. */
  async destroy(device: DeviceRecord): Promise<void> {
    store.patchDevice(device.id, { statusText: 'Removed from the registry - the device itself is untouched' })
  }

  override async status(device: DeviceRecord): Promise<DeviceStatus> {
    // Discovery is the source of truth for physical devices: if the node agent
    // no longer lists it, it has been unplugged, whatever adb says.
    const node = store.getNode(device.node)
    const seen = node?.physical.find(p => p.serial === device.adb.serial)
    if (!node?.reachable) {
      return { state: 'offline', statusText: `The agent on ${device.node} is not reporting in`, adb: { ...device.adb, reachable: false } }
    }
    if (!seen) {
      return { state: 'offline', statusText: 'Unplugged, or no longer visible to ADB', adb: { ...device.adb, reachable: false } }
    }
    if (seen.state === 'unauthorized') {
      return {
        state: 'error',
        statusText: 'The device is showing an "Allow USB debugging?" prompt - somebody has to tap Allow on it once',
        adb: { ...device.adb, reachable: false }
      }
    }
    if (seen.state !== 'device') {
      return { state: 'offline', statusText: `ADB reports it as "${seen.state}"`, adb: { ...device.adb, reachable: false } }
    }
    return super.status(device)
  }

  override async setGps(device: DeviceRecord, _lat: number, _lon: number): Promise<void> {
    throw new UnsupportedByRuntime(
      this.kind,
      `Setting a position on ${device.name} (a real device needs a mock-location app installed and selected in developer options)`
    )
  }
}
