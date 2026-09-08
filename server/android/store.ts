import fs from 'node:fs'
import path from 'node:path'
import { androidConfig } from './config.js'
import type { AuditEntry, DeviceRecord, NodeCapabilities } from './types.js'

/**
 * The device registry's persistence.
 *
 * This is deliberately a small file-backed store rather than a database
 * dependency: ProxBox has no DB today, and the whole subsystem should be
 * droppable into the existing server with zero new packages. It implements the
 * same tables the SQL schema in docs/android/data-model.md describes, behind
 * one interface - swapping in SQLite or Postgres later is a new Store, not a
 * rewrite of the callers.
 *
 * Writes are write-to-temp-then-rename, so a crash mid-write cannot leave a
 * half-parsed registry behind; reads are served from memory.
 */

interface Snapshot {
  devices: DeviceRecord[]
  nodes: NodeCapabilities[]
}

const DEVICES_FILE = 'devices.json'
const NODES_FILE = 'nodes.json'
const AUDIT_FILE = 'audit.log'

class AndroidStore {
  private devices = new Map<string, DeviceRecord>()
  private nodes = new Map<string, NodeCapabilities>()
  private loaded = false
  /** Coalesces bursts of writes (a boot poll touches a device every 2s). */
  private flushTimer: NodeJS.Timeout | null = null
  private dirty = new Set<'devices' | 'nodes'>()

  private file(name: string): string {
    return path.join(androidConfig.stateDir, name)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    fs.mkdirSync(androidConfig.stateDir, { recursive: true })
    for (const [name, target] of [
      [DEVICES_FILE, this.devices],
      [NODES_FILE, this.nodes]
    ] as const) {
      try {
        const file = this.file(name)
        if (!fs.existsSync(file)) continue
        const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id?: string; node?: string }>
        for (const row of rows) {
          const key = (row.id ?? row.node) as string
          if (key) (target as Map<string, unknown>).set(key, row)
        }
      } catch (err) {
        console.error(`[android] could not read ${name}, starting empty:`, err instanceof Error ? err.message : err)
      }
    }
  }

  private markDirty(what: 'devices' | 'nodes'): void {
    this.dirty.add(what)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 250)
    // Never hold the process open just to flush a registry.
    this.flushTimer.unref?.()
  }

  /** Force everything to disk now (used on shutdown and by tests). */
  flush(): void {
    const jobs: Array<[string, unknown[]]> = []
    if (this.dirty.has('devices')) jobs.push([DEVICES_FILE, [...this.devices.values()]])
    if (this.dirty.has('nodes')) jobs.push([NODES_FILE, [...this.nodes.values()]])
    this.dirty.clear()
    for (const [name, rows] of jobs) {
      try {
        fs.mkdirSync(androidConfig.stateDir, { recursive: true })
        const file = this.file(name)
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(rows, null, 2))
        fs.renameSync(tmp, file)
      } catch (err) {
        console.error(`[android] could not write ${name}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  // ---- devices -------------------------------------------------------------

  listDevices(): DeviceRecord[] {
    this.load()
    return [...this.devices.values()].sort((a, b) => {
      // Ready things first, then by name - same instinct as the machine list.
      const rank = (d: DeviceRecord) => (d.state === 'ready' ? 0 : d.state === 'booting' || d.state === 'provisioning' ? 1 : 2)
      const r = rank(a) - rank(b)
      return r !== 0 ? r : a.name.localeCompare(b.name)
    })
  }

  getDevice(id: string): DeviceRecord | undefined {
    this.load()
    return this.devices.get(id)
  }

  putDevice(device: DeviceRecord): DeviceRecord {
    this.load()
    device.updatedAt = Date.now()
    this.devices.set(device.id, device)
    this.markDirty('devices')
    return device
  }

  /** Partial update that never resurrects a deleted device. */
  patchDevice(id: string, patch: Partial<DeviceRecord>): DeviceRecord | undefined {
    this.load()
    const current = this.devices.get(id)
    if (!current) return undefined
    const next: DeviceRecord = { ...current, ...patch, updatedAt: Date.now() }
    this.devices.set(id, next)
    this.markDirty('devices')
    return next
  }

  deleteDevice(id: string): boolean {
    this.load()
    const had = this.devices.delete(id)
    if (had) this.markDirty('devices')
    return had
  }

  // ---- nodes ---------------------------------------------------------------

  listNodes(): NodeCapabilities[] {
    this.load()
    const now = Date.now()
    return [...this.nodes.values()]
      .map(n => ({ ...n, reachable: now - n.lastSeen < androidConfig.agentStaleMs }))
      .sort((a, b) => a.node.localeCompare(b.node))
  }

  getNode(name: string): NodeCapabilities | undefined {
    this.load()
    const n = this.nodes.get(name)
    if (!n) return undefined
    return { ...n, reachable: Date.now() - n.lastSeen < androidConfig.agentStaleMs }
  }

  putNode(node: NodeCapabilities): NodeCapabilities {
    this.load()
    this.nodes.set(node.node, node)
    this.markDirty('nodes')
    return node
  }

  // ---- audit ---------------------------------------------------------------

  /**
   * Append-only, one JSON object per line. Every state-changing call lands here
   * whether it succeeded or not - "who tried to wipe that POS terminal" is
   * exactly the question this has to answer six weeks later.
   */
  audit(entry: AuditEntry): void {
    try {
      fs.mkdirSync(androidConfig.stateDir, { recursive: true })
      fs.appendFileSync(this.file(AUDIT_FILE), JSON.stringify(entry) + '\n')
    } catch (err) {
      console.error('[android] audit write failed:', err instanceof Error ? err.message : err)
    }
  }

  readAudit(limit = 200, deviceId?: string): AuditEntry[] {
    try {
      const file = this.file(AUDIT_FILE)
      if (!fs.existsSync(file)) return []
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
      const out: AuditEntry[] = []
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i]) continue
        try {
          const e = JSON.parse(lines[i]) as AuditEntry
          if (deviceId && e.deviceId !== deviceId) continue
          out.push(e)
        } catch {
          /* skip a torn line rather than fail the whole read */
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** Test/diagnostic helper: everything in one object. */
  snapshot(): Snapshot {
    return { devices: this.listDevices(), nodes: this.listNodes() }
  }
}

export const store = new AndroidStore()
