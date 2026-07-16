import { apiElevated } from './api'

/** Metadata this app stores in the VM description when it spins one up. */
export interface MachineMeta {
  user?: string
  pass?: string
  image?: string
  by?: string
  at?: string
}

export function parseMeta(description?: string): MachineMeta | null {
  if (!description) return null
  const m = description.match(/proxbox:(\{.*\})/s)
  if (!m) return null
  try {
    return JSON.parse(m[1]) as MachineMeta
  } catch {
    return null
  }
}

interface AgentIface {
  name: string
  'ip-addresses'?: { 'ip-address': string; 'ip-address-type': string }[]
}

export type IpResult =
  | { status: 'found'; ip: string }
  | { status: 'no-agent' } // Proxmox: guest agent isn't enabled on this VM's hardware config at all
  | { status: 'waiting' } // agent enabled but hasn't answered yet - booting, or not installed in the guest

/** "no-agent" vs "waiting" matters: one will never resolve on its own, the other might in a few seconds. */
export async function fetchIp(node: string, vmid: number): Promise<IpResult> {
  try {
    const res = await apiElevated<{ result: AgentIface[] }>(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`)
    for (const iface of res.result ?? []) {
      if (iface.name.toLowerCase().startsWith('lo')) continue
      for (const a of iface['ip-addresses'] ?? []) {
        if (a['ip-address-type'] === 'ipv4' && !a['ip-address'].startsWith('127.')) {
          return { status: 'found', ip: a['ip-address'] }
        }
      }
    }
    return { status: 'waiting' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return /no qemu guest agent configured/i.test(msg) ? { status: 'no-agent' } : { status: 'waiting' }
  }
}

export async function fetchMeta(node: string, vmid: number): Promise<MachineMeta | null> {
  try {
    const cfg = await apiElevated<{ description?: string }>(`/nodes/${node}/qemu/${vmid}/config`)
    return parseMeta(cfg.description)
  } catch {
    return null
  }
}
