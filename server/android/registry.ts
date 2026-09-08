import fs from 'node:fs'
import path from 'node:path'
import { androidConfig } from './config.js'
import {
  NO_CAPABILITIES,
  type AndroidImage,
  type Capabilities,
  type DisplaySpec,
  type FormFactor,
  type HardwareProfile,
  type NetworkProfile,
  type ResourceSpec
} from './types.js'

/**
 * The image / profile / form-factor / network registries.
 *
 * Two layers, always: the shipped catalogue in data/, and a writable overlay in
 * the state dir. An admin importing an image or a user saving a custom tablet
 * profile writes to the overlay - the shipped files are never edited, and an
 * app update never clobbers the lab's own catalogue. An overlay entry with the
 * same id as a shipped one wins, which is also how you disable a built-in.
 *
 * Nothing in here is generated from code paths: adding a form factor or a
 * screen shape is a JSON entry, exactly as intended.
 */

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (err) {
    console.error(`[android] ignoring unreadable ${path.basename(file)}:`, err instanceof Error ? err.message : err)
    return fallback
  }
}

function overlayFile(name: string): string {
  return path.join(androidConfig.stateDir, name)
}

function writeOverlay<T>(name: string, rows: T[]): void {
  fs.mkdirSync(androidConfig.stateDir, { recursive: true })
  const file = overlayFile(name)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2))
  fs.renameSync(tmp, file)
}

/** Overlay entries replace shipped ones with the same id; order stays stable. */
function merge<T extends { id: string }>(base: T[], overlay: T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of base) byId.set(row.id, row)
  for (const row of overlay) byId.set(row.id, row)
  return [...byId.values()]
}

const CACHE_MS = 5_000
interface Cached<T> { at: number; rows: T[] }
const caches = new Map<string, Cached<unknown>>()

function load<T extends { id: string }>(name: string): T[] {
  const hit = caches.get(name) as Cached<T> | undefined
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows
  const base = readJson<T[]>(path.join(androidConfig.dataDir, name), [])
  const overlay = readJson<T[]>(overlayFile(name), [])
  const rows = merge(base, overlay)
  caches.set(name, { at: Date.now(), rows })
  return rows
}

/** Drop the memo so the next read sees a just-written overlay. */
function invalidate(name: string): void {
  caches.delete(name)
}

// ---- form factors ----------------------------------------------------------

export function formFactors(): FormFactor[] {
  return load<FormFactor>('form-factors.json')
}

export function formFactor(id: string): FormFactor | undefined {
  return formFactors().find(f => f.id === id)
}

// ---- hardware profiles -----------------------------------------------------

export function hardwareProfiles(): HardwareProfile[] {
  return load<HardwareProfile>('hardware-profiles.json')
}

export function hardwareProfile(id: string): HardwareProfile | undefined {
  return hardwareProfiles().find(p => p.id === id)
}

/** Save (or replace) a user-defined profile. Shipped ids are refused. */
export function saveHardwareProfile(profile: HardwareProfile): HardwareProfile {
  const shipped = readJson<HardwareProfile[]>(path.join(androidConfig.dataDir, 'hardware-profiles.json'), [])
  if (shipped.some(p => p.id === profile.id)) {
    throw new Error(`"${profile.id}" is a built-in profile - save yours under a different name.`)
  }
  const overlay = readJson<HardwareProfile[]>(overlayFile('hardware-profiles.json'), [])
  const rows = merge(overlay, [{ ...profile, custom: true }])
  writeOverlay('hardware-profiles.json', rows)
  invalidate('hardware-profiles.json')
  return profile
}

export function deleteHardwareProfile(id: string): boolean {
  const overlay = readJson<HardwareProfile[]>(overlayFile('hardware-profiles.json'), [])
  const rows = overlay.filter(p => p.id !== id)
  if (rows.length === overlay.length) return false
  writeOverlay('hardware-profiles.json', rows)
  invalidate('hardware-profiles.json')
  return true
}

// ---- images ----------------------------------------------------------------

export function images(): AndroidImage[] {
  const rows = load<AndroidImage>('images.json')
  // The mock image only exists when mock mode is on - otherwise it would show
  // up in the picker as a device nobody can actually use.
  return androidConfig.mock ? rows : rows.filter(i => !i.engines.some(e => e.runtime === 'mock'))
}

export function image(id: string): AndroidImage | undefined {
  return images().find(i => i.id === id)
}

/** Register an admin-imported image. Overlay only; never edits the catalogue. */
export function saveImage(img: AndroidImage): AndroidImage {
  const overlay = readJson<AndroidImage[]>(overlayFile('images.json'), [])
  const rows = merge(overlay, [{ ...img, userSupplied: true }])
  writeOverlay('images.json', rows)
  invalidate('images.json')
  return img
}

export function deleteImage(id: string): boolean {
  const overlay = readJson<AndroidImage[]>(overlayFile('images.json'), [])
  const rows = overlay.filter(i => i.id !== id)
  if (rows.length === overlay.length) return false
  writeOverlay('images.json', rows)
  invalidate('images.json')
  return true
}

// ---- networks --------------------------------------------------------------

export function networkProfiles(): NetworkProfile[] {
  return load<NetworkProfile>('networks.json')
}

export function networkProfile(id: string): NetworkProfile | undefined {
  return networkProfiles().find(n => n.id === id)
}

// ---- resolution ------------------------------------------------------------

/**
 * Turn "AOSP 15 + large tablet + these overrides" into one concrete display,
 * resource and capability set. This is the join the whole subsystem is built
 * around: an image says what it can do, a profile says what shape it is, the
 * request says what the person actually wants, and the answer is one device.
 *
 * Precedence, weakest first: form-factor defaults, hardware profile, explicit
 * request overrides. Capabilities are ANDed with what the image supports -
 * asking for GPS on an image that has no GPS gets you no GPS, and a warning,
 * rather than a device that lies about itself.
 */
export function resolveDisplay(
  ff: FormFactor,
  profile: HardwareProfile | undefined,
  override: Partial<DisplaySpec> | undefined
): DisplaySpec {
  const base: DisplaySpec = profile
    ? { ...profile.display }
    : {
        width: ff.defaults.width,
        height: ff.defaults.height,
        dpi: ff.defaults.dpi,
        orientation: ff.defaults.orientation
      }
  const out: DisplaySpec = { ...base, ...stripUndefined(override ?? {}) }
  // Orientation is a statement about the panel, so keep width/height as given
  // and let the runtime rotate. We only sanity-check the numbers.
  out.width = clamp(Math.round(out.width), 64, 7680)
  out.height = clamp(Math.round(out.height), 64, 7680)
  out.dpi = clamp(Math.round(out.dpi), 60, 640)
  return out
}

export function resolveResources(
  ff: FormFactor,
  profile: HardwareProfile | undefined,
  override: Partial<ResourceSpec> | undefined
): ResourceSpec {
  const base: ResourceSpec = profile
    ? { ...profile.resources }
    : { cpu: ff.defaults.cpu, memoryMb: ff.defaults.ramMb, storageGb: ff.defaults.storageGb }
  const out = { ...base, ...stripUndefined(override ?? {}) }
  return {
    cpu: clamp(Math.round(out.cpu), 1, 32),
    memoryMb: clamp(Math.round(out.memoryMb), 512, 65536),
    storageGb: clamp(Math.round(out.storageGb), 2, 512)
  }
}

/**
 * What the finished device can actually do: image capabilities, narrowed by the
 * form factor, narrowed by what the runtime can honour, then the person's
 * requested features applied on top - but only where the layers below allow it.
 */
export function resolveCapabilities(
  img: AndroidImage,
  ff: FormFactor,
  profile: HardwareProfile | undefined,
  runtimeCaps: Partial<Capabilities>,
  requested: Partial<Capabilities> | undefined
): { capabilities: Capabilities; warnings: string[] } {
  const supported: Capabilities = {
    ...NO_CAPABILITIES,
    ...img.capabilities,
    ...ff.capabilities,
    ...(profile?.capabilities ?? {})
  }
  // The runtime is the final authority on what is real.
  for (const key of Object.keys(supported) as (keyof Capabilities)[]) {
    if (runtimeCaps[key] === false) supported[key] = false
  }
  const warnings: string[] = []
  const out: Capabilities = { ...supported }
  for (const [k, want] of Object.entries(requested ?? {}) as [keyof Capabilities, boolean][]) {
    if (want && !supported[k]) {
      warnings.push(`${label(k)} was asked for but this image/runtime cannot provide it - it will be off.`)
      continue
    }
    out[k] = want
  }
  return { capabilities: out, warnings }
}

function label(key: string): string {
  return key.replace(/_/g, ' ')
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v
  }
  return out
}
