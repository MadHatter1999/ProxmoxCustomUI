import { fitEngine, report as compatReport, sameFamily, type EngineFit } from './compat.js'
import { clusterResources, pveEnabled } from './pve.js'
import {
  formFactor as getFormFactor,
  hardwareProfile,
  hardwareProfiles,
  image as getImage,
  networkProfile,
  resolveCapabilities,
  resolveDisplay,
  resolveResources
} from './registry.js'
import { store } from './store.js'
import { runtimes } from './runtime/index.js'
import type {
  AndroidImage,
  CompatibilityReport,
  DevicePlan,
  DeviceRecord,
  DeviceRequest,
  HardwareProfile,
  ImageEngine,
  NodeCapabilities,
  PlanResult
} from './types.js'

/**
 * The scheduler.
 *
 * It answers one question - "given this request, what exactly would we build,
 * where, with what, and why?" - and it answers it the same way whether or not
 * anyone then presses the button. The UI calls it on every keystroke to show a
 * live compatibility card; create calls it once and builds what it returned.
 *
 * The order below is the pipeline the design asks for, in this order and for
 * these reasons:
 *
 *   1  resolve the image                  - what are we running
 *   2  resolve form factor + profile      - what shape is it
 *   3  merge display/resources/features   - one concrete device
 *   4  choose candidate engines           - how could it run at all
 *   5  physical short-circuit             - is a real device the right answer
 *   6  filter nodes by capability         - KVM, arch, GPU, runtime present
 *   7  filter nodes by free capacity      - RAM, cores, storage headroom
 *   8  score what is left                 - acceleration, GPU, locality, load
 *   9  pick storage (QEMU only)           - fullest-safe-first, like ProxBox does
 *  10  explain the answer                 - reasons and warnings, in words
 *
 * A refusal is a last resort. If the cluster cannot do it virtually but a
 * physical device could, the failure says so.
 */

const GB = 1024 ** 3
const RAM_HEADROOM_MB = 2048 // never squeeze a node to its last byte - same rule as VM placement
const STORAGE_CAP = 0.9      // a new disk must not push a storage past 90%

export interface PlanOptions {
  /** Who is asking - used for "already reserved by you" preferences. */
  user: string
}

export async function planDevice(request: DeviceRequest, opts: PlanOptions): Promise<PlanResult> {
  const detail: string[] = []

  // 1 - the image
  const image = getImage(request.image)
  if (!image) {
    return { ok: false, reason: `There is no Android image called "${request.image}" in the registry.`, detail }
  }

  // 2 - shape: form factor, then a profile inside it
  const ffId = resolveFormFactorId(request) ?? image.formFactors[0] ?? 'phone'
  const ff = getFormFactor(ffId)
  if (!ff) {
    return { ok: false, reason: `There is no form factor called "${ffId}".`, detail }
  }
  if (image.formFactors.length && !image.formFactors.includes(ff.id)) {
    return {
      ok: false,
      reason: `${image.name} does not offer a ${ff.name} build. It covers: ${image.formFactors.join(', ')}.`,
      detail
    }
  }
  const profile = pickProfile(request, ff.id)

  // 3 - one concrete device
  const display = resolveDisplay(ff, profile, request.display)
  const resources = resolveResources(ff, profile, request.resources)
  const network = networkProfile(request.networkProfile ?? 'default')
  if (!network) {
    return { ok: false, reason: `There is no network profile called "${request.networkProfile}".`, detail }
  }
  const persistence = request.persistence ?? 'disposable'

  // 4 - candidate engines, best-preference first, honouring an explicit pin
  let engines = [...image.engines].sort((a, b) => b.preference - a.preference)
  if (request.runtime) {
    engines = engines.filter(e => e.runtime === request.runtime)
    if (!engines.length) {
      return {
        ok: false,
        reason: `${image.name} cannot run under the ${request.runtime} runtime. It supports: ${image.engines.map(e => e.runtime).join(', ')}.`,
        detail
      }
    }
  }

  const nodes = store.listNodes()
  const registered = new Set(runtimes.kinds())
  const attempts: Array<{ engine: ImageEngine; best?: Candidate; detail: string[] }> = []

  for (const engine of engines) {
    if (!registered.has(engine.runtime)) {
      detail.push(`${engine.runtime}: no adapter for it is registered on this controller`)
      continue
    }

    // 5 - a physical device is not scheduled, it is found
    if (engine.runtime === 'physical-adb') {
      const claim = findPhysical(request, image, ff.id, opts.user)
      if (claim.device) {
        const caps = resolveCapabilities(image, ff, profile, runtimes.get(engine.runtime).capabilities, request.features)
        const chosenProfile = profile ?? syntheticProfile(ff.id, display, resources)
        return {
          ok: true,
          request,
          image,
          engine,
          profile: chosenProfile,
          display: request.display || request.hardwareProfile ? display : claim.device.display,
          resources: claim.device.resources,
          capabilities: { ...claim.device.capabilities, ...caps.capabilities },
          network,
          persistence,
          node: claim.device.node,
          score: 1000,
          claimDeviceId: claim.device.id,
          reasons: [
            `${claim.device.name} is a real ${claim.device.androidVersion} device on ${claim.device.node} and it is free.`,
            'A physical device beats emulation for anything that touches real radios, cameras or peripherals.'
          ],
          warnings: caps.warnings
        }
      }
      detail.push(...claim.detail)
      continue
    }

    // 6 + 7 - which nodes can actually take this
    const candidates: Candidate[] = []
    const engineDetail: string[] = []
    for (const node of nodes) {
      if (request.node && node.node !== request.node) continue
      const fit = fitEngine(image, engine, node)
      if (!fit.ok) {
        engineDetail.push(fit.reason ?? `${node.node}: cannot run this`)
        continue
      }
      const freeMb = node.freeRamMb - RAM_HEADROOM_MB
      if (freeMb < resources.memoryMb) {
        engineDetail.push(`${node.node}: ${Math.max(0, Math.round(freeMb / 1024))} GB RAM free, needs ${Math.round(resources.memoryMb / 1024)} GB`)
        continue
      }
      if (node.cores < resources.cpu) {
        engineDetail.push(`${node.node}: ${node.cores} cores, needs ${resources.cpu}`)
        continue
      }
      candidates.push({ node, fit, score: 0, reasons: [] })
    }

    if (!candidates.length) {
      attempts.push({ engine, detail: engineDetail })
      continue
    }

    // 9 - storage, for the runtime that needs it
    let storageByNode = new Map<string, { storage: string; pctAfter: number }>()
    if (engine.runtime === 'qemu') {
      storageByNode = await pickStorage(candidates.map(c => c.node.node), resources.storageGb)
      for (const c of [...candidates]) {
        if (!storageByNode.has(c.node.node)) {
          engineDetail.push(`${c.node.node}: no storage with ${resources.storageGb} GB safely free`)
          candidates.splice(candidates.indexOf(c), 1)
        }
      }
      if (!candidates.length) {
        attempts.push({ engine, detail: engineDetail })
        continue
      }
    }

    // 8 - score
    for (const c of candidates) score(c, image, engine, resources)
    candidates.sort((a, b) => b.score - a.score)
    attempts.push({ engine, best: candidates[0], detail: engineDetail })

    const winner = candidates[0]
    const runtimeCaps = runtimes.get(engine.runtime).capabilities
    const caps = resolveCapabilities(image, ff, profile, runtimeCaps, request.features)
    const warnings = [...caps.warnings]
    if (winner.fit.degraded) warnings.push(winner.fit.degraded)
    if (!sameFamily(winner.node.arch, image.architecture)) {
      warnings.push('This is a cross-architecture run. If it matters, ask for a physical device instead.')
    }
    if (engine.notes) warnings.push(engine.notes)

    return {
      ok: true,
      request,
      image,
      engine,
      profile: profile ?? syntheticProfile(ff.id, display, resources),
      display,
      resources,
      capabilities: caps.capabilities,
      network,
      persistence,
      node: winner.node.node,
      storage: storageByNode.get(winner.node.node)?.storage,
      score: winner.score,
      reasons: winner.reasons,
      warnings
    }
  }

  // Nothing worked. Say why, per engine, and point at the way out.
  for (const a of attempts) detail.push(...a.detail.map(d => `${a.engine.runtime} - ${d}`))
  const physical = findPhysical(request, image, ffId, opts.user)
  return {
    ok: false,
    reason: nodes.length
      ? `Nothing in the cluster can run ${image.name} as a ${ff.name} right now.`
      : 'No node is running the ProxBox Android agent yet, so there is nowhere to put an Android device.',
    detail,
    suggestion: physical.device
      ? `${physical.device.name} on ${physical.device.node} could do it - ask for a physical device instead.`
      : nodes.length
        ? 'Try a smaller size, a different image, or free something up.'
        : 'Install the agent on at least one node (see docs/android/node-agent.md).'
  }
}

interface Candidate {
  node: NodeCapabilities
  fit: EngineFit
  score: number
  reasons: string[]
}

/**
 * Scoring, in priority order and stated in the record so the UI can show why:
 * real acceleration first, then a GPU, then a node that already has the image,
 * then breathing room. Deliberately close in spirit to placement.ts - a person
 * who understands why their VM landed on pve3 should recognise this.
 */
function score(c: Candidate, image: AndroidImage, engine: ImageEngine, resources: { memoryMb: number }): void {
  let s = 0
  if (c.fit.performance === 'native') { s += 400; c.reasons.push(`${c.node.node} runs ${image.architecture} natively with KVM.`) }
  else if (c.fit.performance === 'good') { s += 300; c.reasons.push(`${c.node.node} has KVM for this image.`) }
  else if (c.fit.performance === 'fair') { s += 150; c.reasons.push(`${c.node.node} can run it, with software rendering.`) }
  else if (c.fit.performance === 'poor') { s += 20; c.reasons.push(`${c.node.node} can only translate this architecture - it will be slow.`) }

  if (c.node.gpu?.opengl) { s += 60; c.reasons.push(`It has a usable GPU (${c.node.gpu.model ?? c.node.gpu.vendor ?? 'onboard'}).`) }
  if (c.node.gpu?.vaapi) s += 15 // matters for screen streaming, not for booting

  const sourceKey = engineImageKey(engine)
  if (sourceKey && c.node.cachedImages.includes(sourceKey)) {
    s += 120
    c.reasons.push(`It already has this image staged, so nothing has to be downloaded.`)
  }

  // Free RAM beyond what we need, capped so a huge idle node does not win on
  // size alone when a well-matched one is available.
  const spareGb = Math.max(0, (c.node.freeRamMb - resources.memoryMb) / 1024)
  s += Math.min(100, spareGb * 8)

  // Spread the load: every device already on a node costs it a little.
  const busy = store.listDevices().filter(d => d.node === c.node.node && d.state !== 'stopped').length
  s -= busy * 25
  if (busy) c.reasons.push(`It is running ${busy} other Android ${busy === 1 ? 'device' : 'devices'}.`)

  c.score = Math.round(s)
}

function engineImageKey(engine: ImageEngine): string | null {
  const s = engine.source
  if (s.kind === 'sdk-package') return s.packageName
  if (s.kind === 'pve-iso' || s.kind === 'pve-disk') return s.volid
  if (s.kind === 'agent-path') return s.path
  return null
}

function resolveFormFactorId(request: DeviceRequest): string | undefined {
  if (request.formFactor) return request.formFactor
  if (request.hardwareProfile) return hardwareProfile(request.hardwareProfile)?.formFactor
  return undefined
}

function pickProfile(request: DeviceRequest, ffId: string): HardwareProfile | undefined {
  if (request.hardwareProfile) return hardwareProfile(request.hardwareProfile)
  // No profile named: use the first one for this form factor as the base the
  // overrides sit on, so "tablet, but 1920x480" still starts somewhere sane.
  return hardwareProfiles().find(p => p.formFactor === ffId)
}

/** A profile that was never in the registry - what "Custom" resolves to. */
function syntheticProfile(ffId: string, display: DevicePlan['display'], resources: DevicePlan['resources']): HardwareProfile {
  return {
    id: 'custom',
    name: 'Custom',
    formFactor: ffId,
    display,
    resources,
    capabilities: {},
    custom: true
  }
}

/** Find a free physical device that satisfies the request, or explain why not. */
function findPhysical(
  request: DeviceRequest,
  image: AndroidImage,
  ffId: string,
  user: string
): { device?: DeviceRecord; detail: string[] } {
  const detail: string[] = []
  const all = store.listDevices().filter(d => d.kind === 'physical')
  if (!all.length) {
    detail.push('no physical Android devices are registered on any node')
    return { detail }
  }
  const wantArch = image.variant === 'physical' ? undefined : image.architecture
  const candidates = all.filter(d => {
    if (request.deviceId && d.id !== request.deviceId) return false
    if (d.state !== 'ready') { detail.push(`${d.name}: ${d.state}`); return false }
    // Somebody else's hold blocks it; your own does not - re-opening a device
    // you already have should hand you back the same one.
    if (d.reservation && d.reservation.owner !== user) { detail.push(`${d.name}: in use by ${d.reservation.owner}`); return false }
    if (wantArch && d.architecture !== wantArch) { detail.push(`${d.name}: ${d.architecture}, not ${wantArch}`); return false }
    if (request.formFactor && d.formFactor !== ffId) { detail.push(`${d.name}: a ${d.formFactor}, not a ${ffId}`); return false }
    if (image.apiLevel && image.variant !== 'physical' && d.apiLevel < image.apiLevel) {
      detail.push(`${d.name}: API ${d.apiLevel}, request needs ${image.apiLevel}`)
      return false
    }
    return true
  })
  // Prefer the closest API level rather than the newest device: a request for
  // Android 11 is better served by an Android 11 handset than a Pixel 9.
  candidates.sort((a, b) => {
    // Your own already-held device first, then the closest API level: a request
    // for Android 11 is better served by an Android 11 handset than a Pixel 9.
    const mine = Number(b.reservation?.owner === user) - Number(a.reservation?.owner === user)
    if (mine !== 0) return mine
    return Math.abs(a.apiLevel - image.apiLevel) - Math.abs(b.apiLevel - image.apiLevel)
  })
  return { device: candidates[0], detail }
}

/** Fullest-safe-first storage choice, mirroring how ProxBox already places disks. */
async function pickStorage(nodeNames: string[], needGb: number): Promise<Map<string, { storage: string; pctAfter: number }>> {
  const out = new Map<string, { storage: string; pctAfter: number }>()
  if (!pveEnabled()) return out
  let resources
  try {
    resources = await clusterResources()
  } catch {
    return out
  }
  const needBytes = needGb * GB
  for (const node of nodeNames) {
    const options = resources
      .filter(r => r.type === 'storage' && r.node === node && String(r.content ?? '').includes('images') && Number(r.maxdisk ?? 0) > 0)
      .map(s => ({
        storage: String(s.storage),
        pctAfter: (Number(s.disk ?? 0) + needBytes) / Number(s.maxdisk ?? 1)
      }))
      .filter(s => s.pctAfter <= STORAGE_CAP)
      .sort((a, b) => a.pctAfter - b.pctAfter)
    if (options.length) out.set(node, options[0])
  }
  return out
}

/**
 * The compatibility card for a request, without committing to anything. This
 * is what the create form shows live - "x86_64, QEMU, KVM required and
 * available, GPU optional, performance native" - so nobody discovers the ARM
 * problem after waiting ten minutes for a boot.
 */
export async function explain(request: DeviceRequest, opts: PlanOptions): Promise<CompatibilityReport | null> {
  const image = getImage(request.image)
  if (!image) return null
  const plan = await planDevice(request, opts)
  if (plan.ok) {
    const node = store.getNode(plan.node)
    const fit = node ? fitEngine(image, plan.engine, node) : undefined
    return compatReport(image, plan.engine, node, fit)
  }
  // Even a failure gets a card: it is the most useful moment to explain why.
  const engine = [...image.engines].sort((a, b) => b.preference - a.preference)[0]
  const node = store.listNodes().find(n => n.reachable)
  const fit = node && engine ? fitEngine(image, engine, node) : undefined
  const card = compatReport(image, engine, node, fit)
  card.warnings.unshift(plan.reason)
  if (plan.suggestion) card.recommended = plan.suggestion
  return card
}
