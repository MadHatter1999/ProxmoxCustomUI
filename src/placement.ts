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
  {
    id: 'XXS',
    label: 'XXSmall · 1 vCPU · 1 GB RAM · 30 GB Disk',
    cores: 1,
    memGb: 1,
    diskGb: 30
  },
  {
    id: 'XS',
    label: 'XSmall · 1 vCPU · 2 GB RAM · 60 GB Disk',
    cores: 1,
    memGb: 2,
    diskGb: 60
  },
  {
    id: 'S',
    label: 'Small · 2 vCPU · 4 GB RAM · 60 GB Disk',
    cores: 2,
    memGb: 4,
    diskGb: 60
  },
  {
    id: 'M',
    label: 'Medium · 4 vCPU · 8 GB RAM · 120 GB Disk',
    cores: 4,
    memGb: 8,
    diskGb: 120
  },
  {
    id: 'L',
    label: 'Large · 8 vCPU · 16 GB RAM · 250 GB Disk',
    cores: 8,
    memGb: 16,
    diskGb: 250
  },
  {
    id: 'XL',
    label: 'XLarge · 12 vCPU · 24 GB RAM · 375 GB Disk',
    cores: 12,
    memGb: 24,
    diskGb: 375
  },
  {
    id: '2XL',
    label: '2XLarge · 16 vCPU · 32 GB RAM · 500 GB Disk',
    cores: 16,
    memGb: 32,
    diskGb: 500
  },
  {
    id: '3XL',
    label: '3XLarge · 24 vCPU · 48 GB RAM · 750 GB Disk',
    cores: 24,
    memGb: 48,
    diskGb: 750
  },
  {
    id: '4XL',
    label: '4XLarge · 32 vCPU · 64 GB RAM · 1 TB Disk',
    cores: 32,
    memGb: 64,
    diskGb: 1024
  }
];

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
