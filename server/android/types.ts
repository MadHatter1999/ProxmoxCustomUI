/**
 * ProxBox Android subsystem - the shared vocabulary.
 *
 * The whole point of this subsystem is that "an Android device" is one concept
 * with several implementations. A device is always: an OS IMAGE + a HARDWARE
 * PROFILE + a RUNTIME that satisfies them, running on a NODE. Physical tablets
 * are the degenerate case where the image and hardware are fixed and the
 * runtime is "the thing already on the end of a USB cable".
 *
 * Nothing here is Proxmox-specific on purpose: the QEMU adapter knows about
 * Proxmox, the rest of the subsystem does not.
 */

export type Arch = 'x86' | 'x86_64' | 'arm' | 'arm64'

/**
 * Which implementation actually runs the device. A string union with an escape
 * hatch: a new adapter registers its own id at runtime without anything in the
 * core having to learn about it.
 */
export type RuntimeKind =
  | 'android-emulator' // Google's AVD / emulator binary on a node
  | 'qemu'             // a full Android VM (Android-x86, Bliss, GSI...) via Proxmox
  | 'waydroid'         // containerised Android on a node's kernel
  | 'physical-adb'     // a real device on the end of USB/TCP
  | 'mock'             // in-memory device, for developing the controller offline
  | (string & {})

/** How the bits boot once a runtime has them. */
export type BootMethod = 'avd' | 'qemu-uefi' | 'qemu-bios' | 'container' | 'device'

/** How well a given combination actually works, in plain terms. */
export type SupportLevel =
  | 'supported'    // we run this routinely, it is fine
  | 'experimental' // boots, rough edges, not guaranteed
  | 'legacy'       // old, useful for regression testing, expect papercuts
  | 'unusable'     // technically bootable, practically pointless (state WHY)

export type Orientation = 'portrait' | 'landscape'

/** Everything a device can advertise. Runtimes fill in what they can honour. */
export interface Capabilities {
  touch: boolean
  multitouch: boolean
  keyboard: boolean
  mouse: boolean
  dpad: boolean
  gps: boolean
  camera_front: boolean
  camera_back: boolean
  microphone: boolean
  speaker: boolean
  bluetooth: boolean
  nfc: boolean
  accelerometer: boolean
  gyroscope: boolean
  rotation: boolean
  fold: boolean
  fingerprint: boolean
  telephony: boolean
  adb: boolean
  root: boolean
  play_services: boolean
  screen_record: boolean
}

export const NO_CAPABILITIES: Capabilities = {
  touch: false, multitouch: false, keyboard: false, mouse: false, dpad: false,
  gps: false, camera_front: false, camera_back: false, microphone: false,
  speaker: false, bluetooth: false, nfc: false, accelerometer: false,
  gyroscope: false, rotation: false, fold: false, fingerprint: false,
  telephony: false, adb: false, root: false, play_services: false,
  screen_record: false
}

/**
 * A form factor is DATA, not code. Adding "handheld scanner" or "fridge door
 * panel" is a JSON entry - the backend never switches on this value except to
 * pick sensible defaults and an icon.
 */
export interface FormFactor {
  id: string
  name: string
  /** Grouping for the UI's device filter row. */
  category: 'handheld' | 'tablet' | 'tv' | 'vehicle' | 'wearable' | 'embedded' | 'other'
  /** Defaults a profile may override; also what a bare "form_factor: tv" resolves to. */
  defaults: {
    orientation: Orientation
    dpi: number
    width: number
    height: number
    ramMb: number
    cpu: number
    storageGb: number
  }
  /** Capability hints - a TV has no touch, a wearable has no keyboard. */
  capabilities: Partial<Capabilities>
  /** Which Android "characteristic" the image should be told it is (AVD/GSI hint). */
  characteristic?: 'default' | 'tablet' | 'tv' | 'automotive' | 'watch' | 'emulator'
  notes?: string
}

export interface DisplaySpec {
  width: number
  height: number
  dpi: number
  orientation: Orientation
  refreshHz?: number
  /** For foldables: the second (unfolded) panel. */
  unfolded?: { width: number; height: number; dpi: number }
}

export interface ResourceSpec {
  cpu: number
  memoryMb: number
  storageGb: number
}

/** A reusable hardware shape. Pure data - see data/hardware-profiles.json. */
export interface HardwareProfile {
  id: string
  name: string
  formFactor: string
  display: DisplaySpec
  resources: ResourceSpec
  capabilities: Partial<Capabilities>
  /** Profiles a user saved themselves are marked, so the UI can group them. */
  custom?: boolean
  notes?: string
}

/** Where an image's bits physically live, per runtime. */
export type ImageSource =
  | { kind: 'pve-iso'; volid: string }                     // ISO on Proxmox storage, QEMU boots it
  | { kind: 'pve-template'; vmid: number; node?: string }  // prepared template, linked-cloned
  | { kind: 'pve-disk'; volid: string }                    // qcow2/raw used as a backing file
  | { kind: 'sdk-package'; packageName: string }           // "system-images;android-35;default;x86_64"
  | { kind: 'agent-path'; path: string }                   // a file the node agent already has
  | { kind: 'url'; url: string; sha256?: string }          // fetched on first use
  | { kind: 'device' }                                     // physical: whatever is flashed on it
  | { kind: 'none' }                                       // mock

/** One way this image can be executed, with its real requirements. */
export interface ImageEngine {
  runtime: RuntimeKind
  boot: BootMethod
  requiresKvm: boolean
  /** 'required' means no GPU = no boot; 'optional' means software rendering works. */
  gpu: 'required' | 'preferred' | 'optional' | 'none'
  source: ImageSource
  /** Relative preference when several engines can run the same image (higher wins). */
  preference: number
  support: SupportLevel
  notes?: string
}

export interface AndroidImage {
  id: string
  name: string
  platform: 'android'
  androidVersion: string
  apiLevel: number
  codename?: string
  architecture: Arch
  /** Where the image came from - shown in the UI, switched on by nothing. */
  variant:
    | 'aosp' | 'emulator-system-image' | 'android-x86' | 'bliss' | 'lineage'
    | 'gsi' | 'vendor' | 'custom' | 'physical'
  formFactors: string[]
  googleServices: boolean
  /** Play-certified (licensed Play Store), as opposed to merely "has GApps". */
  playCertified?: boolean
  engines: ImageEngine[]
  capabilities: Partial<Capabilities>
  support: SupportLevel
  /** Set when an admin imported something we cannot redistribute ourselves. */
  userSupplied?: boolean
  notes?: string
}

/** What the UI (or an API client) asks for. Everything except image is optional. */
export interface DeviceRequest {
  platform?: 'android'
  name?: string
  image: string
  formFactor?: string
  hardwareProfile?: string
  resources?: Partial<ResourceSpec>
  display?: Partial<DisplaySpec>
  features?: Partial<Capabilities>
  persistence?: PersistenceMode
  networkProfile?: string
  /** Advanced users can pin a runtime and/or a node; normal users never do. */
  runtime?: RuntimeKind
  node?: string
  /** Physical device requests: claim this exact device instead of creating one. */
  deviceId?: string
  /** Plan it, do not build it. */
  dryRun?: boolean
}

export type PersistenceMode = 'disposable' | 'persistent' | 'snapshot' | 'reset-on-release'

export type NetworkProfileId =
  | 'default' | 'lan' | 'internet-only' | 'nat' | 'no-internet' | 'isolated-lab'
  | (string & {})

export interface NetworkProfile {
  id: NetworkProfileId
  name: string
  /** Proxmox bridge for QEMU devices; agents map this to their own plumbing. */
  bridge: string
  vlan?: number
  firewall: boolean
  internet: boolean
  /** Devices sharing a lab id can see each other and nothing else. */
  labIsolated?: boolean
  description: string
}

/** Node facts the agent reports. Everything optional: an old agent reports less. */
export interface NodeCapabilities {
  node: string
  agentVersion: string
  lastSeen: number
  reachable: boolean
  arch: Arch
  cpuModel?: string
  cpuGeneration?: string
  cores: number
  ramMb: number
  freeRamMb: number
  storageFreeGb?: number
  kvm: boolean
  nestedKvm: boolean
  vtx: boolean
  svm: boolean
  gpu?: { vendor?: string; model?: string; vaapi?: boolean; vulkan?: boolean; opengl?: boolean; quickSync?: boolean }
  runtimes: Partial<Record<string, boolean>>
  usbHost: boolean
  usbip: boolean
  adbVersion?: string
  scrcpyVersion?: string
  /** Image ids this node already has locally - scheduling prefers these. */
  cachedImages: string[]
  /** Devices currently plugged into this node (raw agent view). */
  physical: PhysicalDeviceReport[]
  /** The agent's own base URL, as it told us. */
  endpoint?: string
}

/** One physically connected Android device, exactly as the agent sees it. */
export interface PhysicalDeviceReport {
  serial: string
  state: 'device' | 'unauthorized' | 'offline' | 'recovery' | 'bootloader' | 'sideload' | string
  connection: 'usb' | 'tcp'
  manufacturer?: string
  model?: string
  product?: string
  device?: string
  androidVersion?: string
  apiLevel?: number
  arch?: Arch
  display?: { width: number; height: number; dpi: number; orientation?: Orientation }
  batteryPct?: number
  charging?: boolean
  storageGb?: number
  ramMb?: number
  usbVid?: string
  usbPid?: string
  /** Some devices report a form-factor characteristic we can trust. */
  characteristics?: string
}

export type DeviceState =
  | 'provisioning' // being created / cloned / downloaded
  | 'booting'      // powered on, Android not up yet
  | 'ready'        // Android booted, ADB answering
  | 'stopped'      // exists, not running
  | 'offline'      // physical device unplugged / agent gone
  | 'error'
  | 'deleting'

/** Who currently holds a device. Applies to virtual and physical alike. */
export interface Reservation {
  owner: string
  since: number
  /** Auto-release time; the reaper drops the hold when this passes. */
  expiresAt?: number
  note?: string
}

/** The one record type the UI renders, for every kind of Android device. */
export interface DeviceRecord {
  id: string
  name: string
  platform: 'android'
  kind: 'virtual' | 'physical'
  runtime: RuntimeKind
  node: string
  state: DeviceState
  /** Free-text detail behind the state - "waiting for ADB", "no space on pve4". */
  statusText?: string
  imageId: string
  imageName: string
  androidVersion: string
  apiLevel: number
  architecture: Arch
  formFactor: string
  hardwareProfileId?: string
  display: DisplaySpec
  resources: ResourceSpec
  capabilities: Capabilities
  persistence: PersistenceMode
  network: NetworkProfileId
  /** null when nobody holds it - that is what "AVAILABLE" means in the UI. */
  reservation: Reservation | null
  adb: { serial?: string; endpoint?: string; reachable: boolean }
  /** Runtime-private handles. Nothing outside the owning adapter reads these. */
  backing: Record<string, string | number | undefined>
  createdBy: string
  createdAt: number
  updatedAt: number
  bootedAt?: number
  error?: string
}

/** The scheduler's answer: what it would do, and why. */
export interface DevicePlan {
  request: DeviceRequest
  image: AndroidImage
  engine: ImageEngine
  profile: HardwareProfile
  display: DisplaySpec
  resources: ResourceSpec
  capabilities: Capabilities
  network: NetworkProfile
  persistence: PersistenceMode
  node: string
  /** Proxmox storage for QEMU devices; undefined for agent-run runtimes. */
  storage?: string
  score: number
  /** Human sentences: why this node, why this engine. Shown in the UI. */
  reasons: string[]
  warnings: string[]
  /** Set for a physical claim rather than a fresh build. */
  claimDeviceId?: string
}

/** Why a request cannot be satisfied - always in words a person can act on. */
export interface PlanFailure {
  ok: false
  reason: string
  /** Per-candidate detail: "pve4: no KVM", "pve6: 1.2 GB RAM free (need 4)". */
  detail: string[]
  /** If a physical device would satisfy it, say so instead of just failing. */
  suggestion?: string
}

export type PlanResult = ({ ok: true } & DevicePlan) | PlanFailure

/** The compatibility answer the UI shows before anyone clicks Create. */
export interface CompatibilityReport {
  image: string
  architecture: Arch
  hostArchitecture: Arch
  bootMethod: BootMethod
  runtime: RuntimeKind
  kvm: 'required-available' | 'required-unavailable' | 'not-required' | 'unavailable-translated'
  gpu: 'required' | 'preferred' | 'optional' | 'none'
  performance: 'native' | 'good' | 'fair' | 'poor' | 'unusable'
  support: SupportLevel
  playServices: boolean
  recommended?: string
  warnings: string[]
}

/** Audit trail entry. Every state-changing call writes one. */
export interface AuditEntry {
  at: number
  user: string
  action: string
  deviceId?: string
  detail?: string
  ok: boolean
}
