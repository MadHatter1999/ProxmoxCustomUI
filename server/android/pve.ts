/**
 * A minimal Proxmox client for the Android subsystem.
 *
 * server/index.ts already has elevatedGet/elevatedRequest helpers, but they are
 * private to that module and tied to an incoming request. Rather than reach in
 * and change working code, this repeats the two calls it needs - the same
 * deliberate "kept in sync, not imported" pattern already used for parseMeta
 * and pickIsoTarget. Both read the same PVE_ROOT_TOKEN.
 *
 * If ProxBox ever grows a shared PVE module, this file is the first thing that
 * should be deleted in favour of it.
 */

const PVE_HOST = process.env.PVE_HOST ?? 'https://192.168.200.100:8006'
const ROOT_TOKEN = process.env.PVE_ROOT_TOKEN ?? ''

export class PveError extends Error {}

function requireToken(): string {
  if (!ROOT_TOKEN) {
    throw new PveError('Server has no PVE_ROOT_TOKEN configured - ask Tony to set one up')
  }
  return ROOT_TOKEN
}

export async function pveGet<T>(pvePath: string): Promise<T> {
  const r = await fetch(`${PVE_HOST}${pvePath}`, {
    headers: { Authorization: `PVEAPIToken=${requireToken()}` }
  })
  if (!r.ok) throw new PveError(`PVE GET ${pvePath} -> ${r.status}`)
  return ((await r.json()) as { data: T }).data
}

export async function pveWrite<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  pvePath: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const init: RequestInit = { method, headers: { Authorization: `PVEAPIToken=${requireToken()}` } }
  if (params && method !== 'DELETE') {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      body.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
    }
    init.body = body
    ;(init.headers as Record<string, string>)['content-type'] = 'application/x-www-form-urlencoded'
  }
  const r = await fetch(`${PVE_HOST}${pvePath}`, init)
  const text = await r.text()
  if (!r.ok) throw new PveError(`PVE ${method} ${pvePath} -> ${r.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text).data as T
  } catch {
    return text as unknown as T
  }
}

export interface PveResource {
  type: string
  node?: string
  status?: string
  storage?: string
  content?: string
  vmid?: number
  name?: string
  maxmem?: number
  mem?: number
  maxcpu?: number
  cpu?: number
  disk?: number
  maxdisk?: number
  shared?: number
}

export function clusterResources(): Promise<PveResource[]> {
  return pveGet<PveResource[]>('/api2/json/cluster/resources')
}

export function nextVmid(): Promise<number> {
  return pveGet<number>('/api2/json/cluster/nextid')
}

export async function vmStatus(node: string, vmid: number): Promise<string> {
  const st = await pveGet<{ status?: string }>(`/api2/json/nodes/${node}/qemu/${vmid}/status/current`)
  return st.status ?? 'unknown'
}

/** A locally administered, unicast MAC we choose ourselves so we can find the VM's IP later. */
export function randomMac(): string {
  const bytes = [0x02, 0, 0, 0, 0, 0]
  for (let i = 1; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

export const pveEnabled = (): boolean => !!ROOT_TOKEN
