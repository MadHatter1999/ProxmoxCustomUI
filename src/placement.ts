import type { ClusterResource } from './types'

/** Where the full Proxmox GUI lives - only used for the setup console link. */
export const PVE_GUI = 'https://192.168.200.100:8006'

const GB = 1024 ** 3

export interface SizePreset {
  id: string
  label: string
  cores: number
  memGb: number
  diskGb: number
}

export const SIZES: SizePreset[] = [
  { id: 'XS', label: 'XSmall-1CPU · 2GBRAM · 60GBDisk · 1core', cores: 1, memGb: 2, diskGb: 60 },
  { id: 'S', label: 'Small-2CPU · 4GBRAM · 60GBDisk · 2core', cores: 2, memGb: 4, diskGb: 60 },
  { id: 'M', label: 'Medium-4CPU · 8GBRAM · 120GBDisk · 4core', cores: 4, memGb: 8, diskGb: 120 },
  { id: 'L', label: 'Large-8CPU · 16GBRAM · 250GBDisk · 8core', cores: 8, memGb: 16, diskGb: 250 }
]

export interface Placement {
  node: string
  storage: string
}

export type PlaceResult = { ok: true; placement: Placement } | { ok: false; reason: string }

const HEADROOM_RAM_GB = 2 // never squeeze a host to its last byte
const STORAGE_CAP = 0.9 // a new disk must not push a storage past 90%

/**
 * Pick the node + storage for a new machine across EVERY online node,
 * favouring the one with the most free RAM and its least-full image storage.
 * `allowedNodes` (when given) restricts to nodes that can actually see the
 * chosen image - the app mediates; the tech never has to care where it lands.
 * Returns a human explanation when nothing fits.
 */
export function place(resources: ClusterResource[], size: SizePreset, allowedNodes?: string[]): PlaceResult {
  const nodes = resources.filter(r => r.type === 'node' && r.status === 'online')
  const storages = resources.filter(r => r.type === 'storage' && (r.content ?? '').includes('images'))

  const needMem = size.memGb * GB
  const needDisk = size.diskGb * GB

  interface Candidate {
    node: string
    freeMem: number
    storage: string
    storagePctAfter: number
  }
  const candidates: Candidate[] = []
  const problems: string[] = []

  for (const n of nodes.sort((a, b) => (a.node ?? '').localeCompare(b.node ?? ''))) {
    if (allowedNodes && !allowedNodes.includes(n.node!)) {
      problems.push(`${n.node}: can't see this image`)
      continue
    }
    const freeMem = (n.maxmem ?? 0) - (n.mem ?? 0) - HEADROOM_RAM_GB * GB
    const cpuOk = (n.maxcpu ?? 0) >= size.cores
    if (!cpuOk) {
      problems.push(`${n.node}: only ${n.maxcpu} CPU cores (need ${size.cores})`)
      continue
    }
    if (freeMem < needMem) {
      problems.push(`${n.node}: ${(freeMem / GB).toFixed(1)} GB RAM free (need ${size.memGb})`)
      continue
    }
    const nodeStorages = storages
      .filter(s => s.node === n.node && s.maxdisk)
      .map(s => ({
        storage: s.storage!,
        pctAfter: ((s.disk ?? 0) + needDisk) / (s.maxdisk ?? 1)
      }))
      .filter(s => s.pctAfter <= STORAGE_CAP)
      .sort((a, b) => a.pctAfter - b.pctAfter)
    if (!nodeStorages.length) {
      problems.push(`${n.node}: no storage with ${size.diskGb} GB safely free`)
      continue
    }
    candidates.push({
      node: n.node!,
      freeMem,
      storage: nodeStorages[0].storage,
      storagePctAfter: nodeStorages[0].pctAfter
    })
  }

  if (!candidates.length) {
    const detail = problems.length ? problems.join(' · ') : 'no nodes are online'
    return {
      ok: false,
      reason: `The Proxbox can't fit a ${size.id} machine right now - ${detail}. Try a smaller size, stop something you're not using, or ask Tony.`
    }
  }

  candidates.sort((a, b) => b.freeMem - a.freeMem)
  return { ok: true, placement: { node: candidates[0].node, storage: candidates[0].storage } }
}

export interface IsoTarget {
  node: string
  storage: string
  pctUsed: number
  freeBytes: number
}

/**
 * Where a newly-uploaded ISO should land. pve1 physically holds the real
 * /var/lib/vz/template/iso directory and NFS-exports it to pve3/pve4 - only
 * pve2 keeps a private, unshared copy (see the lab's storage notes). Uploading
 * anywhere else risks writing an image half the cluster can't see, so this
 * always targets pve1's storage when it's online; otherwise the least-bad
 * fallback is whichever other node has iso-capable storage.
 */
export function pickIsoTarget(resources: ClusterResource[]): IsoTarget | null {
  const isoStorages = resources.filter(
    r => r.type === 'storage' && (r.content ?? '').includes('iso') && r.status === 'active'
  )
  if (!isoStorages.length) return null
  const onPve1 = isoStorages.find(s => s.node === 'pve1')
  const chosen = onPve1 ?? isoStorages[0]
  const maxdisk = chosen.maxdisk ?? 1
  const used = chosen.disk ?? 0
  return {
    node: chosen.node!,
    storage: chosen.storage!,
    pctUsed: (used / maxdisk) * 100,
    freeBytes: maxdisk - used
  }
}

/** One-line, plain-English capacity summary for the header. */
export function capacityLine(resources: ClusterResource[]): string {
  const nodes = resources.filter(r => r.type === 'node' && r.status === 'online')
  if (!nodes.length) return 'Lab status: no hosts reachable'
  const freeGb = nodes.reduce((t, n) => t + ((n.maxmem ?? 0) - (n.mem ?? 0)), 0) / GB
  const biggest = SIZES.filter(s => place(resources, s).ok).pop()
  return biggest
    ? `Lab has ${freeGb.toFixed(0)} GB RAM free - up to a ${biggest.label.split(' - ')[0]} machine right now`
    : `Lab is full - ${freeGb.toFixed(0)} GB RAM free but no host/storage can fit a new machine`
}
