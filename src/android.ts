import { AuthError, clearSession } from './api'

/**
 * Client half of the Android subsystem.
 *
 * The types here mirror server/android/types.ts. They are duplicated rather
 * than imported for the same reason parseMeta and pickIsoTarget are duplicated
 * in server/index.ts - the browser bundle and the server are separate builds
 * with separate tsconfigs, and this app has never shared a types package.
 * Keep the two in step by hand; they change rarely and together.
 */

export type Arch = 'x86' | 'x86_64' | 'arm' | 'arm64'
export type Orientation = 'portrait' | 'landscape'
export type PersistenceMode = 'disposable' | 'persistent' | 'snapshot' | 'reset-on-release'
export type DeviceState = 'provisioning' | 'booting' | 'ready' | 'stopped' | 'offline' | 'error' | 'deleting'

export interface DisplaySpec {
  width: number
  height: number
  dpi: number
  orientation: Orientation
  unfolded?: { width: number; height: number; dpi: number }
}

export interface ResourceSpec {
  cpu: number
  memoryMb: number
  storageGb: number
}

export type Capabilities = Record<string, boolean>

export interface FormFactor {
  id: string
  name: string
  category: string
  defaults: { orientation: Orientation; dpi: number; width: number; height: number; ramMb: number; cpu: number; storageGb: number }
  capabilities: Partial<Capabilities>
  notes?: string
}

export interface HardwareProfile {
  id: string
  name: string
  formFactor: string
  display: DisplaySpec
  resources: ResourceSpec
  capabilities: Partial<Capabilities>
  custom?: boolean
  notes?: string
}

export interface ImageEngine {
  runtime: string
  boot: string
  requiresKvm: boolean
  gpu: 'required' | 'preferred' | 'optional' | 'none'
  preference: number
  support: string
  notes?: string
}

export interface AndroidImage {
  id: string
  name: string
  androidVersion: string
  apiLevel: number
  architecture: Arch
  variant: string
  formFactors: string[]
  googleServices: boolean
  playCertified?: boolean
  engines: ImageEngine[]
  support: 'supported' | 'experimental' | 'legacy' | 'unusable'
  userSupplied?: boolean
  notes?: string
}

export interface NetworkProfile {
  id: string
  name: string
  description: string
}

export interface AndroidVersionRow {
  androidVersion: string
  apiLevel: number
  codename: string
  bootable: boolean
  usable: boolean
  accelerated: boolean
  playServices: boolean
  appTesting: string
  support: string
  notes: string
}

export interface Catalog {
  images: AndroidImage[]
  hardwareProfiles: HardwareProfile[]
  formFactors: FormFactor[]
  networks: NetworkProfile[]
  runtimes: string[]
  androidVersions: AndroidVersionRow[]
  mock: boolean
}

export interface NodeCapabilities {
  node: string
  agentVersion: string
  lastSeen: number
  reachable: boolean
  arch: Arch
  cpuModel?: string
  cores: number
  ramMb: number
  freeRamMb: number
  kvm: boolean
  nestedKvm: boolean
  gpu?: { vendor?: string; model?: string; vaapi?: boolean; opengl?: boolean }
  runtimes: Record<string, boolean>
  usbHost: boolean
  cachedImages: string[]
  physical: Array<{ serial: string; state: string; model?: string }>
}

export interface Reservation {
  owner: string
  since: number
  expiresAt?: number
  note?: string
}

export interface AndroidDevice {
  id: string
  name: string
  kind: 'virtual' | 'physical'
  runtime: string
  node: string
  state: DeviceState
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
  network: string
  reservation: Reservation | null
  adb: { serial?: string; endpoint?: string; reachable: boolean }
  createdBy: string
  createdAt: number
  bootedAt?: number
  error?: string
}

export interface CompatibilityReport {
  image: string
  architecture: Arch
  hostArchitecture: Arch
  bootMethod: string
  runtime: string
  kvm: 'required-available' | 'required-unavailable' | 'not-required' | 'unavailable-translated'
  gpu: string
  performance: 'native' | 'good' | 'fair' | 'poor' | 'unusable'
  support: string
  playServices: boolean
  recommended?: string
  warnings: string[]
}

export interface DeviceRequest {
  name?: string
  image: string
  formFactor?: string
  hardwareProfile?: string
  resources?: Partial<ResourceSpec>
  display?: Partial<DisplaySpec>
  features?: Partial<Capabilities>
  persistence?: PersistenceMode
  networkProfile?: string
  runtime?: string
  node?: string
  deviceId?: string
}

export interface PlanOk {
  ok: true
  node: string
  storage?: string
  engine: ImageEngine
  display: DisplaySpec
  resources: ResourceSpec
  capabilities: Capabilities
  score: number
  reasons: string[]
  warnings: string[]
  claimDeviceId?: string
}

export interface PlanFail {
  ok: false
  reason: string
  detail: string[]
  suggestion?: string
}

export type PlanResult = PlanOk | PlanFail

/** Every Android call goes through here, so 401 handling stays in one place. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/svc/android${path}`, init)
  if (r.status === 401) {
    clearSession()
    throw new AuthError()
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (typeof j.message === 'string') msg = j.message
      if (Array.isArray(j.detail) && j.detail.length) msg += ` (${j.detail.slice(0, 3).join('; ')})`
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg)
  }
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

export const androidApi = {
  catalog: () => call<Catalog>('/catalog'),
  nodes: () => call<NodeCapabilities[]>('/nodes'),
  devices: () => call<AndroidDevice[]>('/devices'),
  device: (id: string) => call<AndroidDevice>(`/devices/${id}`),

  plan: (request: DeviceRequest) =>
    call<{ plan: PlanResult; compatibility: CompatibilityReport | null }>('/plan', json(request)),

  create: (request: DeviceRequest) => call<AndroidDevice>('/devices', json(request)),

  action: (id: string, action: 'start' | 'stop' | 'reboot' | 'reset') =>
    call<AndroidDevice>(`/devices/${id}/${action}`, { method: 'POST' }),

  destroy: (id: string) => call<{ ok: true }>(`/devices/${id}`, { method: 'DELETE' }),

  reserve: (id: string, minutes?: number) => call<AndroidDevice>(`/devices/${id}/reserve`, json({ minutes })),
  release: (id: string) => call<AndroidDevice>(`/devices/${id}/release`, { method: 'POST' }),

  shell: (id: string, command: string) => call<{ output: string }>(`/devices/${id}/shell`, json({ command })),

  input: (id: string, body: Record<string, unknown>) => call<{ ok: true }>(`/devices/${id}/input`, json(body)),

  setDisplay: (id: string, body: { width?: number; height?: number; dpi?: number; orientation?: Orientation }) =>
    call<AndroidDevice>(`/devices/${id}/display`, json(body)),

  sensors: (id: string, body: Record<string, unknown>) => call<{ ok: true }>(`/devices/${id}/sensors`, json(body)),

  properties: (id: string) => call<Record<string, string>>(`/devices/${id}/properties`),

  uninstall: (id: string, packageName: string) =>
    call<{ output: string }>(`/devices/${id}/uninstall`, json({ packageName })),

  /** The screen is a plain image URL - cache-busted per frame by the caller. */
  screenUrl: (id: string, frame: number) => `/svc/android/devices/${id}/screen?f=${frame}`,

  async installApk(id: string, file: File, onProgress?: (pct: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/svc/android/devices/${id}/install?name=${encodeURIComponent(file.name)}`)
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status === 401) {
          clearSession()
          reject(new AuthError())
          return
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText).output as string)
          } catch {
            resolve('Installed')
          }
        } else {
          let msg = `Install failed (HTTP ${xhr.status})`
          try {
            const j = JSON.parse(xhr.responseText)
            if (typeof j.message === 'string') msg = j.message
          } catch {
            /* non-JSON error body */
          }
          reject(new Error(msg))
        }
      }
      xhr.onerror = () => reject(new Error('Install failed - connection dropped'))
      xhr.send(file)
    })
  }
}

/** Shared display helpers, so the cards and the create form agree on wording. */
export const stateLabel: Record<DeviceState, string> = {
  provisioning: 'Building',
  booting: 'Booting',
  ready: 'Ready',
  stopped: 'Off',
  offline: 'Offline',
  error: 'Problem',
  deleting: 'Removing'
}

export function runtimeLabel(runtime: string): string {
  switch (runtime) {
    case 'android-emulator': return 'Emulator'
    case 'qemu': return 'Android VM'
    case 'physical-adb': return 'Physical'
    case 'waydroid': return 'Waydroid'
    case 'mock': return 'Mock'
    default: return runtime
  }
}

export function performanceLabel(p: CompatibilityReport['performance']): string {
  switch (p) {
    case 'native': return 'Full speed (KVM + GPU)'
    case 'good': return 'Full speed (KVM)'
    case 'fair': return 'Usable - software rendering'
    case 'poor': return 'Slow - instruction translation'
    default: return 'Will not run here'
  }
}
