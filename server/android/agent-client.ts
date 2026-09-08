import crypto from 'node:crypto'
import { androidConfig } from './config.js'
import { store } from './store.js'
import type { PhysicalDeviceReport } from './types.js'

/**
 * Talking to the node agents.
 *
 * The controller is the only thing that ever speaks to an agent, and an agent
 * is the only thing that ever speaks ADB. That is the whole security story for
 * item 21: raw ADB is never exposed - not to the browser, not to the lab LAN.
 *
 * Every request is signed with a shared secret over (timestamp, method, path,
 * body hash), so a captured URL is useless a minute later and a body cannot be
 * altered in flight. It is not TLS-with-certificates, and does not pretend to
 * be; see docs/android/security.md for what it does and does not defend.
 */

export interface AdbResult {
  code: number
  stdout: Buffer
  stderr: string
}

export class AgentError extends Error {}

function sign(method: string, pathname: string, body: Buffer): { ts: string; sig: string } {
  const ts = String(Date.now())
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex')
  const sig = crypto
    .createHmac('sha256', androidConfig.agentToken)
    .update(`${ts}\n${method}\n${pathname}\n${bodyHash}`)
    .digest('hex')
  return { ts, sig }
}

function endpointFor(node: string): string {
  const known = store.getNode(node)
  if (known?.endpoint) return known.endpoint
  // Fall back to the node's own name on the agent port - works whenever the
  // controller can resolve node names, which it can on the lab LAN.
  return `http://${node}:${androidConfig.agentPort}`
}

async function call(node: string, method: 'GET' | 'POST', pathname: string, payload?: unknown, timeoutMs = 30_000): Promise<Buffer> {
  if (!androidConfig.agentToken) {
    throw new AgentError('No ANDROID_AGENT_TOKEN is configured, so ProxBox cannot talk to node agents yet.')
  }
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload))
  const { ts, sig } = sign(method, pathname, body)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpointFor(node)}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-proxbox-ts': ts,
        'x-proxbox-sig': sig
      },
      body: method === 'GET' ? undefined : new Uint8Array(body),
      signal: ctl.signal
    })
    const buf = Buffer.from(await res.arrayBuffer())
    if (!res.ok) {
      let msg = `agent on ${node} answered ${res.status}`
      try {
        const j = JSON.parse(buf.toString('utf8')) as { message?: string }
        if (j.message) msg = `${node}: ${j.message}`
      } catch { /* non-JSON error body */ }
      throw new AgentError(msg)
    }
    return buf
  } catch (err) {
    if (err instanceof AgentError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AgentError(`the agent on ${node} did not answer within ${Math.round(timeoutMs / 1000)}s`)
    }
    throw new AgentError(`could not reach the agent on ${node}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function callJson<T>(node: string, method: 'GET' | 'POST', pathname: string, payload?: unknown, timeoutMs?: number): Promise<T> {
  const buf = await call(node, method, pathname, payload, timeoutMs)
  return JSON.parse(buf.toString('utf8')) as T
}

export const agent = {
  /**
   * Run an adb command against one device on one node.
   *
   * `args` is an argv array, never a shell string: a package name or a file
   * path from the UI can then never turn into a shell metacharacter on a
   * Proxmox host. The agent execs adb directly for the same reason.
   */
  async adb(node: string, serial: string | undefined, args: string[], opts: { stdin?: Buffer; timeoutMs?: number } = {}): Promise<AdbResult> {
    const res = await callJson<{ code: number; stdout: string; stderr: string }>(
      node,
      'POST',
      '/adb',
      { serial, args, stdin: opts.stdin ? opts.stdin.toString('base64') : undefined },
      opts.timeoutMs ?? 60_000
    )
    return { code: res.code, stdout: Buffer.from(res.stdout ?? '', 'base64'), stderr: res.stderr ?? '' }
  },

  /** Same, but fails loudly instead of returning a non-zero exit quietly. */
  async adbOk(node: string, serial: string | undefined, args: string[], opts: { stdin?: Buffer; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.adb(node, serial, args, opts)
    if (r.code !== 0) {
      throw new AgentError(`adb ${args[0]} failed on ${node}: ${(r.stderr || r.stdout.toString('utf8')).trim().slice(0, 300)}`)
    }
    return r.stdout.toString('utf8')
  },

  /** Raw bytes back (screencap, screenrecord, file pull). */
  async adbBinary(node: string, serial: string | undefined, args: string[], timeoutMs = 60_000): Promise<Buffer> {
    const r = await this.adb(node, serial, args, { timeoutMs })
    if (r.code !== 0) {
      throw new AgentError(`adb ${args[0]} failed on ${node}: ${r.stderr.trim().slice(0, 300)}`)
    }
    return r.stdout
  },

  /** Attach a network-reachable device (an Android VM) to this node's adb. */
  connect(node: string, hostPort: string): Promise<{ ok: boolean; message?: string }> {
    return callJson(node, 'POST', '/connect', { target: hostPort }, 20_000)
  },

  disconnect(node: string, hostPort: string): Promise<{ ok: boolean }> {
    return callJson(node, 'POST', '/disconnect', { target: hostPort }, 20_000)
  },

  devices(node: string): Promise<PhysicalDeviceReport[]> {
    return callJson(node, 'GET', '/devices', undefined, 20_000)
  },

  /**
   * Resolve a MAC we chose ourselves to its current address on the bridge.
   * Android VMs have no guest agent, so this is how the controller finds them;
   * the agent reads the neighbour table and nudges it with a ping sweep if the
   * entry has not appeared yet.
   */
  ipForMac(node: string, mac: string): Promise<{ ip?: string }> {
    return callJson(node, 'POST', '/net/ip-for-mac', { mac }, 30_000)
  },

  // ---- emulator (AVD) lifecycle -------------------------------------------

  createAvd(node: string, spec: AvdSpec): Promise<{ avd: string }> {
    return callJson(node, 'POST', '/avd/create', spec, 300_000)
  },

  startAvd(node: string, avd: string, opts: AvdStartOptions): Promise<{ serial: string; port: number }> {
    return callJson(node, 'POST', '/avd/start', { avd, ...opts }, 180_000)
  },

  stopAvd(node: string, avd: string): Promise<{ ok: boolean }> {
    return callJson(node, 'POST', '/avd/stop', { avd }, 60_000)
  },

  deleteAvd(node: string, avd: string): Promise<{ ok: boolean }> {
    return callJson(node, 'POST', '/avd/delete', { avd }, 60_000)
  },

  /** Fetch a system image onto the node if it is not there yet. */
  ensureImage(node: string, packageName: string): Promise<{ ok: boolean; installed: boolean }> {
    return callJson(node, 'POST', '/sdk/ensure', { packageName }, 1_800_000)
  }
}

export interface AvdSpec {
  name: string
  packageName: string
  width: number
  height: number
  dpi: number
  ramMb: number
  cores: number
  storageGb: number
  /** AVD "tag" characteristic: default / tablet / tv / automotive / watch. */
  characteristic?: string
  /** Extra hardware properties written into config.ini verbatim. */
  hardware?: Record<string, string>
}

export interface AvdStartOptions {
  gpu: 'host' | 'swiftshader_indirect' | 'off' | 'auto'
  headless: boolean
  /** Wipe user data on this boot - how a disposable device gets reset. */
  wipeData?: boolean
  /** Snapshot to boot from, for fast create-from-base. */
  snapshot?: string
  networkProfile?: string
}
