import { agent } from '../agent-client.js'
import { androidConfig } from '../config.js'
import { nextVmid, pveEnabled, pveWrite, randomMac, vmStatus } from '../pve.js'
import { store } from '../store.js'
import { newDeviceId, slug } from '../util.js'
import type { Capabilities, DevicePlan, DeviceRecord, RuntimeKind } from '../types.js'
import { AdbBackedAdapter } from './adb-base.js'
import type { CreateContext, DeviceStatus } from './adapter.js'

/**
 * Full Android VMs on Proxmox: Android-x86, Bliss OS, LineageOS x86 builds,
 * GSIs, and anything else an admin stages as an ISO or a template.
 *
 * This adapter is the one that reuses ProxBox's existing world wholesale - a
 * device here is an ordinary Proxmox VM, on the same bridges and storages, and
 * it shows up in the Proxmox UI like anything else. Two consequences worth
 * stating plainly:
 *
 *  - Copy-on-write comes free. A prepared template plus `clone full=0` is a
 *    linked clone: three devices off one base image cost one base image plus
 *    three deltas, which is exactly the storage model item 20 asks for.
 *
 *  - There is no guest agent. Android-x86 does not ship qemu-guest-agent, so
 *    the VM's address cannot be read the way ProxBox reads a Windows VM's. We
 *    pick the MAC ourselves at create time and have the node agent resolve it
 *    from the bridge's neighbour table, then adb-connect to it. That is why
 *    the base template must have ADB-over-TCP enabled - see the runbook in
 *    docs/android/runtimes.md.
 */
export class QemuAndroidAdapter extends AdbBackedAdapter {
  readonly kind: RuntimeKind = 'qemu'
  readonly name = 'Android VM (QEMU/KVM via Proxmox)'

  /**
   * Plain QEMU has no console channel into Android, so anything that needs one
   * is off. Everything achievable over adb stays on.
   */
  readonly capabilities: Partial<Capabilities> = {
    touch: true,
    multitouch: true,
    keyboard: true,
    mouse: true,
    rotation: true,
    adb: true,
    screen_record: true,
    // No emulator console: no injected fixes, no hinge, no simulated sensors.
    gps: false,
    fold: false,
    accelerometer: false,
    gyroscope: false,
    nfc: false,
    bluetooth: false,
    fingerprint: false,
    telephony: false
  }

  async available(): Promise<boolean> {
    return pveEnabled()
  }

  async create(plan: DevicePlan, ctx: CreateContext): Promise<DeviceRecord> {
    if (!pveEnabled()) throw new Error('Android VMs need PVE_ROOT_TOKEN configured on the ProxBox server.')
    const id = newDeviceId()
    const name = `${androidConfig.vmNamePrefix}${slug(plan.request.name ?? plan.image.name)}`
    const storage = plan.storage
    if (!storage) throw new Error('No storage was chosen for this device - that is a scheduler bug, not your fault.')

    const mac = randomMac()
    const vmid = await nextVmid()
    const source = plan.engine.source
    const net0 = `virtio=${mac},bridge=${plan.network.bridge}${plan.network.firewall ? ',firewall=1' : ''}${plan.network.vlan ? `,tag=${plan.network.vlan}` : ''}`

    if (source.kind === 'pve-template') {
      ctx.progress(`Linked-cloning the ${plan.image.name} template`)
      // full=0 is the copy-on-write path: the clone shares the base image's
      // blocks and only stores what it changes.
      await pveWrite('POST', `/api2/json/nodes/${source.node ?? plan.node}/qemu/${source.vmid}/clone`, {
        newid: vmid,
        name,
        full: false,
        target: source.node && source.node !== plan.node ? plan.node : undefined,
        description: this.description(plan, id)
      })
      await pveWrite('PUT', `/api2/json/nodes/${plan.node}/qemu/${vmid}/config`, {
        cores: plan.resources.cpu,
        memory: plan.resources.memoryMb,
        net0
      })
    } else if (source.kind === 'pve-iso') {
      ctx.progress(`Building a VM to install ${plan.image.name}`)
      await pveWrite('POST', `/api2/json/nodes/${plan.node}/qemu`, {
        vmid,
        name,
        cores: plan.resources.cpu,
        sockets: 1,
        memory: plan.resources.memoryMb,
        ostype: 'l26',
        machine: 'q35',
        bios: plan.engine.boot === 'qemu-uefi' ? 'ovmf' : 'seabios',
        cpu: 'host',
        vga: this.vga(plan),
        scsihw: 'virtio-scsi-single',
        scsi0: `${storage}:${plan.resources.storageGb},discard=on`,
        ide2: `${source.volid},media=cdrom`,
        net0,
        boot: 'order=ide2;scsi0',
        agent: 0,
        description: this.description(plan, id),
        ...(plan.engine.boot === 'qemu-uefi' ? { efidisk0: `${storage}:1,efitype=4m` } : {})
      })
    } else {
      throw new Error(`${plan.image.name} has no bits ProxBox can boot as a VM (source: ${source.kind}).`)
    }

    const firstBootIsInstall = source.kind === 'pve-iso'
    const device: DeviceRecord = {
      id,
      name: plan.request.name?.trim() || name,
      platform: 'android',
      kind: 'virtual',
      runtime: this.kind,
      node: plan.node,
      state: 'provisioning',
      statusText: firstBootIsInstall
        ? 'Installer image: complete the Android setup once on its screen, then save it as a base template'
        : 'Starting the VM',
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
      backing: { vmid, storage, mac, install: firstBootIsInstall ? 1 : 0 },
      createdBy: ctx.user,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.putDevice(device)

    ctx.progress('Powering it on')
    await this.start(device)
    return store.getDevice(id) ?? device
  }

  /** Same "created with ProxBox" convention the existing VM path uses. */
  private description(plan: DevicePlan, deviceId: string): string {
    return `Created with ProxBox (Android)\nproxbox-android:${JSON.stringify({
      deviceId,
      image: plan.image.id,
      profile: plan.profile.id,
      display: `${plan.display.width}x${plan.display.height}@${plan.display.dpi}`
    })}`
  }

  private vga(plan: DevicePlan): string {
    // virtio-gpu is what Android-x86 is happiest with when there is any GPU
    // path at all; std is the safe fallback and is what a headless device gets.
    const node = store.getNode(plan.node)
    if (plan.profile.formFactor === 'headless') return 'std'
    return node?.gpu?.opengl ? 'virtio' : 'std'
  }

  async start(device: DeviceRecord): Promise<void> {
    const vmid = Number(device.backing.vmid)
    await pveWrite('POST', `/api2/json/nodes/${device.node}/qemu/${vmid}/status/start`).catch((err: unknown) => {
      // "already running" is success as far as anyone calling start() cares.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already running/i.test(msg)) throw err
    })
    store.patchDevice(device.id, { state: 'booting', statusText: 'Android is starting' })
  }

  async stop(device: DeviceRecord): Promise<void> {
    const vmid = Number(device.backing.vmid)
    if (device.adb.serial) await agent.disconnect(device.node, device.adb.serial).catch(() => {})
    await pveWrite('POST', `/api2/json/nodes/${device.node}/qemu/${vmid}/status/shutdown`, { timeout: 60 }).catch(async () => {
      await pveWrite('POST', `/api2/json/nodes/${device.node}/qemu/${vmid}/status/stop`)
    })
    store.patchDevice(device.id, { state: 'stopped', statusText: undefined, adb: { reachable: false } })
  }

  override async reboot(device: DeviceRecord): Promise<void> {
    const vmid = Number(device.backing.vmid)
    await pveWrite('POST', `/api2/json/nodes/${device.node}/qemu/${vmid}/status/reboot`)
    store.patchDevice(device.id, { state: 'booting', statusText: 'Rebooting', adb: { ...device.adb, reachable: false } })
  }

  /**
   * Back to base. A device created from a template gets a 'proxbox-base'
   * snapshot the first time it reaches ready, so reset is a rollback - seconds,
   * not a rebuild.
   */
  async reset(device: DeviceRecord): Promise<void> {
    const vmid = Number(device.backing.vmid)
    const snap = 'proxbox-base'
    await this.stop(device).catch(() => {})
    await pveWrite('POST', `/api2/json/nodes/${device.node}/qemu/${vmid}/snapshot/${snap}/rollback`)
    store.patchDevice(device.id, { state: 'booting', statusText: 'Rolled back to its base image' })
    await this.start(device)
  }

  async destroy(device: DeviceRecord): Promise<void> {
    const vmid = Number(device.backing.vmid)
    if (!vmid) return
    if (device.adb.serial) await agent.disconnect(device.node, device.adb.serial).catch(() => {})
    await pveWrite('POST', `/api2/json/nodes/${device.node}/qemu/${vmid}/status/stop`).catch(() => {})
    // Proxmox refuses to delete a VM that is still stopping; give it a moment.
    await new Promise(r => setTimeout(r, 3000))
    await pveWrite('DELETE', `/api2/json/nodes/${device.node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`)
  }

  /**
   * Status has one extra job here: attaching ADB. There is no guest agent, so
   * we resolve the MAC we chose at create time to an address on the bridge and
   * adb-connect to it. Once that lands the device behaves like any other.
   */
  override async status(device: DeviceRecord): Promise<DeviceStatus> {
    const vmid = Number(device.backing.vmid)
    let running = false
    try {
      running = (await vmStatus(device.node, vmid)) === 'running'
    } catch (err) {
      return { state: 'error', error: err instanceof Error ? err.message : String(err) }
    }
    if (!running) return { state: 'stopped', adb: { reachable: false } }

    if (device.backing.install === 1) {
      return {
        state: 'booting',
        statusText: 'Waiting for the one-time Android install to finish on its screen'
      }
    }

    if (!device.adb.serial) {
      const attached = await this.attachAdb(device)
      if (!attached) {
        return { state: 'booting', statusText: 'Waiting for the device to pick up an address and answer ADB' }
      }
      return { state: 'booting', statusText: 'ADB attached - waiting for Android to finish booting', adb: { serial: attached, reachable: true } }
    }
    return super.status(device)
  }

  /** MAC -> address on the bridge -> adb connect. Returns the serial, or null. */
  private async attachAdb(device: DeviceRecord): Promise<string | null> {
    const mac = String(device.backing.mac ?? '')
    if (!mac) return null
    try {
      const found = await agent.ipForMac(device.node, mac)
      if (!found.ip) return null
      const target = `${found.ip}:5555`
      const res = await agent.connect(device.node, target)
      if (!res.ok) return null
      store.patchDevice(device.id, {
        adb: { serial: target, endpoint: found.ip, reachable: true },
        backing: { ...device.backing, ip: found.ip }
      })
      return target
    } catch {
      return null
    }
  }

  /**
   * The VM boots at whatever resolution its kernel command line says, so the
   * requested shape is applied to Android itself once it is up. This is the
   * same mechanism that lets one image serve a phone and a tablet.
   */
  async applyShape(device: DeviceRecord): Promise<void> {
    await this.setDisplay(device, device.display)
    await this.setOrientation(device, device.display.orientation).catch(() => {})
  }
}
