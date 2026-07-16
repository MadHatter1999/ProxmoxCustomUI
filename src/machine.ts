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

export async function fetchIp(node: string, vmid: number): Promise<string | null> {
  try {
    const res = await apiElevated<{ result: AgentIface[] }>(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`)
    for (const iface of res.result ?? []) {
      if (iface.name.toLowerCase().startsWith('lo')) continue
      for (const a of iface['ip-addresses'] ?? []) {
        if (a['ip-address-type'] === 'ipv4' && !a['ip-address'].startsWith('127.')) return a['ip-address']
      }
    }
  } catch {
    /* no guest agent - expected on fresh installs */
  }
  return null
}

export async function fetchMeta(node: string, vmid: number): Promise<MachineMeta | null> {
  try {
    const cfg = await apiElevated<{ description?: string }>(`/nodes/${node}/qemu/${vmid}/config`)
    return parseMeta(cfg.description)
  } catch {
    return null
  }
}
