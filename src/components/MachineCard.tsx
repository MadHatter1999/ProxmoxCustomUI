import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ClusterResource } from '../types'
import { PVE_GUI } from '../placement'
import { downloadRdp } from '../rdp'

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

async function fetchIp(node: string, vmid: number): Promise<string | null> {
  try {
    const res = await api<{ result: AgentIface[] }>(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`)
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

interface Snapshot {
  name: string
  snaptime?: number
  description?: string
}

export default function MachineCard({ vm, onAction, onTask }: {
  vm: ClusterResource
  onAction: (vm: ClusterResource, action: 'start' | 'shutdown' | 'stop') => void
  onTask: (upid: string, node: string, label: string) => void
}) {
  const running = vm.status === 'running'
  const [ip, setIp] = useState<string | null>(null)
  const [meta, setMeta] = useState<MachineMeta | null>(null)
  const [showLogin, setShowLogin] = useState(false)
  const [showSnaps, setShowSnaps] = useState(false)
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [snapName, setSnapName] = useState('')
  const [rdpBusy, setRdpBusy] = useState(false)

  useEffect(() => {
    let stop = false
    if (running && vm.node && vm.vmid) {
      fetchIp(vm.node, vm.vmid).then(v => { if (!stop) setIp(v) })
    } else {
      setIp(null)
    }
    return () => { stop = true }
  }, [running, vm.node, vm.vmid])

  useEffect(() => {
    let stop = false
    if (vm.node && vm.vmid) {
      api<{ description?: string }>(`/nodes/${vm.node}/qemu/${vm.vmid}/config`)
        .then(cfg => { if (!stop) setMeta(parseMeta(cfg.description)) })
        .catch(() => {})
    }
    return () => { stop = true }
  }, [vm.node, vm.vmid])

  const loadSnaps = useCallback(() => {
    api<Snapshot[]>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot`)
      .then(list =>
        setSnaps(
          list
            .filter(s => s.name !== 'current')
            .sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0))
        )
      )
      .catch(() => setSnaps([]))
  }, [vm.node, vm.vmid])

  useEffect(() => {
    if (showSnaps) loadSnaps()
  }, [showSnaps, loadSnaps])

  async function takeSnap() {
    const name = snapName.trim()
    if (!name) return
    try {
      const upid = await api<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot`, {
        method: 'POST',
        params: { snapname: name, description: `via The Proxbox (${new Date().toISOString().slice(0, 10)})` }
      })
      onTask(upid, vm.node!, `Snapshotting ${vm.name} as "${name}"`)
      setSnapName('')
      setTimeout(loadSnaps, 5000)
    } catch (err) {
      alert(`Couldn't snapshot: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function rollbackSnap(name: string) {
    if (!confirm(`Roll ${vm.name} back to "${name}"?\n\nEverything done on it since that snapshot is thrown away, and the machine restarts from that point.`)) return
    try {
      const upid = await api<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot/${encodeURIComponent(name)}/rollback`, {
        method: 'POST'
      })
      onTask(upid, vm.node!, `Rolling ${vm.name} back to "${name}"`)
    } catch (err) {
      alert(`Couldn't roll back: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function deleteSnap(name: string) {
    if (!confirm(`Delete snapshot "${name}" of ${vm.name}? The machine itself is not touched - you just lose this restore point.`)) return
    try {
      const upid = await api<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot/${encodeURIComponent(name)}`, {
        method: 'DELETE'
      })
      onTask(upid, vm.node!, `Deleting snapshot "${name}" of ${vm.name}`)
      setTimeout(loadSnaps, 5000)
    } catch (err) {
      alert(`Couldn't delete: ${err instanceof Error ? err.message : err}`)
    }
  }

  /** Reach into the guest via the QEMU agent: create the assigned user and open RDP. */
  async function openRdpAccess() {
    if (!meta?.user || !meta.pass) return
    setRdpBusy(true)
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    const script =
      `$u=${q(meta.user)};$p=${q(meta.pass)};` +
      `net user $u $p /add 2>$null; if($LASTEXITCODE -ne 0){ net user $u $p };` +
      `net localgroup 'Remote Desktop Users' $u /add 2>$null;` +
      `net localgroup Administrators $u /add 2>$null;` +
      `Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0 -Type DWord;` +
      `Enable-NetFirewallRule -DisplayGroup 'Remote Desktop';` +
      `Write-Output RDP-READY`
    try {
      const r = await api<{ pid: number }>(`/nodes/${vm.node}/qemu/${vm.vmid}/agent/exec`, {
        method: 'POST',
        params: { command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script] }
      })
      await new Promise(res => setTimeout(res, 4000))
      const st = await api<{ exited: number; 'out-data'?: string; 'err-data'?: string }>(
        `/nodes/${vm.node}/qemu/${vm.vmid}/agent/exec-status`,
        { params: { pid: r.pid } }
      )
      if (st.exited && st['out-data']?.includes('RDP-READY')) {
        alert(`RDP is open on ${vm.name}. Download the RDP file and sign in as ${meta.user}.`)
      } else {
        alert(`Sent - ${vm.name} is applying it${st['err-data'] ? ` but reported: ${st['err-data'].slice(0, 200)}` : ' (give it a few seconds)'}.`)
      }
    } catch {
      alert(
        `Couldn't reach inside ${vm.name} - it may still be booting, or this image has no guest agent. ` +
        `For fresh installs, turn on Remote Desktop during Windows setup instead.`
      )
    } finally {
      setRdpBusy(false)
    }
  }

  return (
    <div className={`card machine-card ${running ? 'machine-on' : ''}`}>
      <div className="card-head">
        <span className={`dot ${running ? 'dot-good' : 'dot-muted'}`} aria-hidden />
        <strong>{vm.name}</strong>
        <span className={`pill ${running ? 'pill-on' : 'pill-off'}`}>{running ? 'Live' : 'Off'}</span>
      </div>
      {meta?.image && <p className="muted machine-sub">{meta.image}</p>}
      <p className="machine-net">
        {running
          ? ip
            ? <>Address: <code>{ip}</code></>
            : <span className="muted">Address: still booting / not reported yet…</span>
          : <span className="muted">Start the machine to connect.</span>}
      </p>
      {showLogin && meta?.user && (
        <p className="machine-net">
          Login: <code>{meta.user}</code> / <code>{meta.pass}</code>
        </p>
      )}
      <div className="machine-actions">
        {!running && !vm.template && <button className="primary" onClick={() => onAction(vm, 'start')}>Start</button>}
        {running && ip && (
          <button className="primary" onClick={() => downloadRdp(vm.name ?? 'machine', ip, meta?.user)}>
            Connect (RDP)
          </button>
        )}
        {running && meta?.user && (
          <button onClick={openRdpAccess} disabled={rdpBusy}>{rdpBusy ? 'Opening…' : 'Open RDP access'}</button>
        )}
        {meta?.user && (
          <button className="small" onClick={() => setShowLogin(s => !s)}>{showLogin ? 'Hide login' : 'Show login'}</button>
        )}
        <button className="small" onClick={() => setShowSnaps(s => !s)}>Snapshots</button>
        {running && <button className="small" onClick={() => onAction(vm, 'shutdown')}>Turn off</button>}
        {running && <button className="small danger" onClick={() => onAction(vm, 'stop')}>Force off</button>}
        <a
          className="console-link"
          href={`${PVE_GUI}/?console=kvm&novnc=1&vmid=${vm.vmid}&node=${vm.node}`}
          target="_blank"
          rel="noreferrer"
        >
          screen
        </a>
      </div>

      {showSnaps && (
        <div className="snap-panel">
          <div className="snap-new">
            <input
              value={snapName}
              onChange={e => setSnapName(e.target.value)}
              placeholder="snapshot name (e.g. before-update)"
              pattern="[A-Za-z0-9_\-]+"
              title="Letters, digits, dashes and underscores"
            />
            <button className="small" onClick={takeSnap} disabled={!snapName.trim()}>Take snapshot</button>
          </div>
          {snaps.length === 0 && <p className="muted">No snapshots yet - take one before risky changes.</p>}
          {snaps.map(s => (
            <div key={s.name} className="snap-row">
              <span className="snap-name">{s.name}</span>
              <span className="muted">
                {s.snaptime ? new Date(s.snaptime * 1000).toLocaleString() : ''}
              </span>
              <span className="snap-spacer" />
              <button className="small" onClick={() => rollbackSnap(s.name)}>Restore</button>
              <button className="small danger" onClick={() => deleteSnap(s.name)}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
