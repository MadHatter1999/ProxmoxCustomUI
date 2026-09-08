import type {
  AndroidImage,
  Arch,
  CompatibilityReport,
  ImageEngine,
  NodeCapabilities,
  SupportLevel
} from './types.js'

/**
 * Compatibility: what a given image + engine + node actually adds up to.
 *
 * The rule this file exists to enforce: never answer "unsupported" when the
 * honest answer is "here is what it would cost". A request the cluster can only
 * satisfy slowly, or only on a physical device, is far more useful stated that
 * way than refused.
 */

/** x86 code runs on an x86_64 host; ARM does not. */
const FAMILY: Record<Arch, 'x86' | 'arm'> = {
  x86: 'x86',
  x86_64: 'x86',
  arm: 'arm',
  arm64: 'arm'
}

export function sameFamily(a: Arch, b: Arch): boolean {
  return FAMILY[a] === FAMILY[b]
}

/** A 64-bit host runs 32-bit guests of the same family; the reverse is not true. */
export function hostCanAccelerate(host: Arch, guest: Arch): boolean {
  if (!sameFamily(host, guest)) return false
  if (guest === 'x86_64' && host === 'x86') return false
  if (guest === 'arm64' && host === 'arm') return false
  return true
}

/**
 * The Android version support model (item 14).
 *
 * "Bootable" and "useful" are different questions and the registry is expected
 * to say which is which. These rows are what the UI shows next to an image so
 * nobody has to find out the hard way that KitKat has no screen recording.
 */
export interface AndroidVersionRow {
  androidVersion: string
  apiLevel: number
  codename: string
  /** Will it boot at all under one of our runtimes? */
  bootable: boolean
  /** Would a person actually get work done on it? */
  usable: boolean
  /** Can it use KVM + a GPU path, or is it software all the way down? */
  accelerated: boolean
  /** Does Google still ship an emulator system image for it? */
  emulatorImages: boolean
  /** Can Play Services realistically run on it today? */
  playServices: boolean
  /** Is it worth pointing an app test suite at? */
  appTesting: 'recommended' | 'useful' | 'niche' | 'no'
  support: SupportLevel
  notes: string
}

export const ANDROID_VERSIONS: AndroidVersionRow[] = [
  { androidVersion: '16', apiLevel: 36, codename: 'Baklava', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'recommended', support: 'experimental', notes: 'Newest images; stage them as they are published. Treated as experimental until we have run them here.' },
  { androidVersion: '15', apiLevel: 35, codename: 'Vanilla Ice Cream', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'recommended', support: 'supported', notes: 'Current default for new devices.' },
  { androidVersion: '14', apiLevel: 34, codename: 'Upside Down Cake', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'recommended', support: 'supported', notes: 'Also the TV / Automotive / Wear baseline.' },
  { androidVersion: '13', apiLevel: 33, codename: 'Tiramisu', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'recommended', support: 'supported', notes: 'Bliss OS 16 and most current x86 community builds sit here.' },
  { androidVersion: '12', apiLevel: 31, codename: 'Snow Cone', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'recommended', support: 'supported', notes: '' },
  { androidVersion: '11', apiLevel: 30, codename: 'R', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'recommended', support: 'supported', notes: 'Common minSdk floor for enterprise apps.' },
  { androidVersion: '10', apiLevel: 29, codename: 'Q', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'useful', support: 'supported', notes: '' },
  { androidVersion: '9', apiLevel: 28, codename: 'Pie', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'useful', support: 'legacy', notes: 'Last Android-x86 release lives here. Good regression target.' },
  { androidVersion: '8.1', apiLevel: 27, codename: 'Oreo', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: true, appTesting: 'useful', support: 'legacy', notes: '' },
  { androidVersion: '7.1', apiLevel: 25, codename: 'Nougat', bootable: true, usable: true, accelerated: true, emulatorImages: true, playServices: false, appTesting: 'useful', support: 'legacy', notes: 'Play Services stopped shipping updates for this era; app-only testing.' },
  { androidVersion: '6', apiLevel: 23, codename: 'Marshmallow', bootable: true, usable: true, accelerated: false, emulatorImages: true, playServices: false, appTesting: 'niche', support: 'legacy', notes: 'Runtime-permissions boundary - genuinely useful for permission-flow regressions.' },
  { androidVersion: '5', apiLevel: 21, codename: 'Lollipop', bootable: true, usable: true, accelerated: false, emulatorImages: true, playServices: false, appTesting: 'niche', support: 'legacy', notes: 'Software rendering; slow but it works.' },
  { androidVersion: '4.4', apiLevel: 19, codename: 'KitKat', bootable: true, usable: false, accelerated: false, emulatorImages: true, playServices: false, appTesting: 'niche', support: 'legacy', notes: 'Boots and installs APKs. No multi-touch, no screen recording, no modern sensor injection. Prove-it-launches only.' },
  { androidVersion: '4.1-4.3', apiLevel: 16, codename: 'Jelly Bean', bootable: true, usable: false, accelerated: false, emulatorImages: true, playServices: false, appTesting: 'no', support: 'legacy', notes: 'The practical floor. Modern adb still speaks to it, barely; expect to fight it.' },
  { androidVersion: '2.x-4.0', apiLevel: 15, codename: 'ICS and older', bootable: false, usable: false, accelerated: false, emulatorImages: false, playServices: false, appTesting: 'no', support: 'unusable', notes: 'Not offered. The images are ARM-only or long gone from the SDK, and current adb/emulator builds no longer handle them.' }
]

export function versionRow(apiLevel: number): AndroidVersionRow | undefined {
  return ANDROID_VERSIONS.find(v => v.apiLevel === apiLevel)
    ?? ANDROID_VERSIONS.find(v => apiLevel >= v.apiLevel)
}

/** Why a specific engine cannot run on a specific node, in one sentence. */
export interface EngineFit {
  ok: boolean
  reason?: string
  /** Set when it runs, but badly. */
  degraded?: string
  performance: CompatibilityReport['performance']
  kvm: CompatibilityReport['kvm']
}

/**
 * Can this node run this engine for this image, and how well?
 *
 * The interesting cases:
 *  - x86_64 image, x86_64 host, KVM present  -> native. The normal path.
 *  - x86 image on x86_64 host                -> native (32-bit guest, same family).
 *  - ARM image on x86 host                   -> TCG translation. Boots, crawls.
 *  - KVM required but absent                 -> not viable at all under AVD.
 *  - GPU required but absent                 -> not viable; 'preferred' just warns.
 */
export function fitEngine(img: AndroidImage, engine: ImageEngine, node: NodeCapabilities): EngineFit {
  if (!node.reachable) {
    return { ok: false, reason: `${node.node}: agent has not checked in`, performance: 'unusable', kvm: 'not-required' }
  }
  if (node.runtimes[engine.runtime] !== true) {
    return {
      ok: false,
      reason: `${node.node}: does not have the ${engine.runtime} runtime installed`,
      performance: 'unusable',
      kvm: 'not-required'
    }
  }

  const accel = hostCanAccelerate(node.arch, img.architecture)

  if (engine.runtime === 'physical-adb' || engine.runtime === 'mock') {
    return { ok: true, performance: 'native', kvm: 'not-required' }
  }

  if (!accel) {
    // Cross-architecture. Only QEMU can do it at all, and only through TCG.
    if (engine.runtime !== 'qemu') {
      return {
        ok: false,
        reason: `${node.node}: ${img.architecture} cannot run under ${engine.runtime} on an ${node.arch} host`,
        performance: 'unusable',
        kvm: 'required-unavailable'
      }
    }
    if (engine.requiresKvm) {
      return {
        ok: false,
        reason: `${node.node}: this image needs KVM, and KVM cannot accelerate ${img.architecture} on ${node.arch}`,
        performance: 'unusable',
        kvm: 'required-unavailable'
      }
    }
    return {
      ok: true,
      degraded: `${img.architecture} is emulated instruction-by-instruction on this ${node.arch} host (QEMU TCG). Expect a slow boot and single-digit frame rates - fine for a headless run, painful to drive by hand.`,
      performance: 'poor',
      kvm: 'unavailable-translated'
    }
  }

  if (engine.requiresKvm && !node.kvm) {
    return {
      ok: false,
      reason: `${node.node}: KVM is not available (needed by this image)`,
      performance: 'unusable',
      kvm: 'required-unavailable'
    }
  }

  if (engine.gpu === 'required' && !node.gpu?.opengl) {
    return {
      ok: false,
      reason: `${node.node}: this image needs a working GPU path and the node reports none`,
      performance: 'unusable',
      kvm: engine.requiresKvm ? 'required-available' : 'not-required'
    }
  }

  const kvm: CompatibilityReport['kvm'] = engine.requiresKvm
    ? 'required-available'
    : node.kvm
      ? 'required-available'
      : 'not-required'

  if (engine.gpu === 'preferred' && !node.gpu?.opengl) {
    return {
      ok: true,
      degraded: `${node.node} has no GPU acceleration, so this falls back to software rendering (SwiftShader). Usable, but heavier on CPU and choppier on a large screen.`,
      performance: 'fair',
      kvm
    }
  }

  return { ok: true, performance: node.gpu?.opengl ? 'native' : 'good', kvm }
}

/** The human-readable compatibility card the UI shows before Create is clicked. */
export function report(
  img: AndroidImage,
  engine: ImageEngine,
  node: NodeCapabilities | undefined,
  fit: EngineFit | undefined
): CompatibilityReport {
  const hostArch: Arch = node?.arch ?? 'x86_64'
  const row = versionRow(img.apiLevel)
  const warnings: string[] = []
  if (fit?.degraded) warnings.push(fit.degraded)
  if (fit && !fit.ok && fit.reason) warnings.push(fit.reason)
  if (row && !row.usable) warnings.push(`Android ${row.androidVersion}: ${row.notes}`)
  if (engine.support === 'experimental') warnings.push('This combination is experimental here - it boots, but treat oddities as expected.')
  if (img.userSupplied) warnings.push('User-supplied image: ProxBox does not download or verify these, it just runs what an admin staged.')

  let recommended: string | undefined
  if (!sameFamily(hostArch, img.architecture)) {
    recommended = 'A physical ARM device on a node - the cluster is x86-64, so ARM images are translated, not accelerated.'
  } else if (fit && !fit.ok) {
    recommended = 'Another node, or a smaller device - see the detail above.'
  }

  return {
    image: img.id,
    architecture: img.architecture,
    hostArchitecture: hostArch,
    bootMethod: engine.boot,
    runtime: engine.runtime,
    kvm: fit?.kvm ?? (engine.requiresKvm ? 'required-unavailable' : 'not-required'),
    gpu: engine.gpu,
    performance: fit?.performance ?? 'unusable',
    support: engine.support,
    playServices: !!img.googleServices,
    recommended,
    warnings
  }
}
