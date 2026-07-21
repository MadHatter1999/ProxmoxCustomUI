import { useCallback, useEffect, useState } from 'react'
import { api, apiElevated } from '../api'
import type { ClusterResource } from '../types'
import { fetchIp, parseMeta, type IpResult, type MachineMeta } from '../machine'
import Console from './Console'
import RdpSession from './RdpSession'

interface Snapshot {
  name: string
  snaptime?: number
  description?: string
}

export default function MachineCard({ vm, isRoot, refreshTick, onAction, onTask, onRefresh, onAuthError }: {
  vm: ClusterResource
  isRoot: boolean
  refreshTick: number
  onAction: (vm: ClusterResource, action: 'start' | 'shutdown' | 'stop') => void
  onTask: (upid: string, node: string, label: string) => void
  onRefresh: () => void
  onAuthError: () => void
}) {
  const running = vm.status === 'running'
  const [unlocking, setUnlocking] = useState(false)
  const [ipResult, setIpResult] = useState<IpResult>({ status: 'waiting' })
  const [meta, setMeta] = useState<MachineMeta | null>(null)
  const [ostype, setOstype] = useState<string | null>(null)
  const [showLogin, setShowLogin] = useState(false)
  const [showSnaps, setShowSnaps] = useState(false)
  const [showConsole, setShowConsole] = useState(false)
  const [showRdp, setShowRdp] = useState(false)
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [snapName, setSnapName] = useState('')
  const [rdpBusy, setRdpBusy] = useState(false)

  useEffect(() => {
    let stop = false
    if (running && vm.node && vm.vmid) {
      fetchIp(vm.node, vm.vmid).then(v => { if (!stop) setIpResult(v) })
    } else {
      setIpResult({ status: 'waiting' })
    }
    return () => { stop = true }
  }, [running, vm.node, vm.vmid])

  useEffect(() => {
    let stop = false
    if (vm.node && vm.vmid) {
      apiElevated<{ description?: string; ostype?: string }>(`/nodes/${vm.node}/qemu/${vm.vmid}/config`)
        .then(cfg => {
          if (stop) return
          setMeta(parseMeta(cfg.description))
          setOstype(cfg.ostype ?? null)
        })
        .catch(() => {})
    }
    return () => { stop = true }
  }, [vm.node, vm.vmid])

  // Proxmox's Windows ostype values all start with "w" (win11, win10, win7,
  // wxp, w2k, ...); Linux is l24/l26, plus solaris/other. "Open RDP access"
  // runs Windows-only PowerShell inside the guest, so it's actively wrong to
  // offer it - and try it - on anything else.
  const isWindows = ostype?.startsWith('w') ?? false

  const loadSnaps = useCallback(() => {
    apiElevated<Snapshot[]>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot`)
      .then(list =>
        setSnaps(
          list
            .filter(s => s.name !== 'current')
            .sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0))
        )
      )
      .catch(() => setSnaps([]))
  }, [vm.node, vm.vmid])

  // Reload the list when the panel opens AND every time a tracked task finishes
  // (refreshTick bumps on real task completion). The old code reloaded on a blind
  // 5s timer, so a snapshot of a running VM - which writes RAM state and takes far
  // longer than 5s - had usually not finished yet, and the new snapshot never
  // showed up. Tying the reload to actual completion fixes that.
  useEffect(() => {
    if (showSnaps) loadSnaps()
  }, [showSnaps, loadSnaps, refreshTick])

  async function takeSnap() {
    const name = snapName.trim()
    if (!name) return
    try {
      const upid = await apiElevated<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot`, {
        method: 'POST',
        params: { snapname: name, description: `via The Proxbox (${new Date().toISOString().slice(0, 10)})` }
      })
      onTask(upid, vm.node!, `Snapshotting ${vm.name} as "${name}"`)
      setSnapName('')
      // The list refreshes when this task actually finishes (see refreshTick
      // effect above) - not on a guessed timer that fires before it's done.
    } catch (err) {
      alert(`Couldn't snapshot: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function rollbackSnap(name: string) {
    if (!confirm(`Roll ${vm.name} back to "${name}"?\n\nEverything done on it since that snapshot is thrown away, and the machine restarts from that point.`)) return
    try {
      const upid = await apiElevated<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot/${encodeURIComponent(name)}/rollback`, {
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
      const upid = await apiElevated<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/snapshot/${encodeURIComponent(name)}`, {
        method: 'DELETE'
      })
      onTask(upid, vm.node!, `Deleting snapshot "${name}" of ${vm.name}`)
      // Refreshes on task completion (refreshTick effect), not a blind timer.
    } catch (err) {
      alert(`Couldn't delete: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Clear a stuck lock. When a snapshot/rollback/backup task is interrupted, the
   * guest is left "locked" and then every later snapshot, rollback, start and
   * stop fails with "VM is locked" - with no way out from inside the app until
   * now. Uses the caller's OWN session on purpose: skiplock is root@pam-only, so
   * the root API token behind apiElevated is explicitly refused ("Only root may
   * use this option"). That's why this is gated to root in the UI.
   */
  async function unlockVm() {
    if (!confirm(
      `Clear the "${vm.lock}" lock on ${vm.name}?\n\n` +
      `Only do this if a snapshot or rollback got stuck. Don't do it while one is ` +
      `genuinely still running - let that finish first.`
    )) return
    setUnlocking(true)
    try {
      await api(`/nodes/${vm.node}/qemu/${vm.vmid}/config`, {
        method: 'PUT',
        params: { skiplock: 1, delete: 'lock' }
      })
      onRefresh()
    } catch (err) {
      alert(`Couldn't unlock: ${err instanceof Error ? err.message : err}`)
    } finally {
      setUnlocking(false)
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
      const r = await apiElevated<{ pid: number }>(`/nodes/${vm.node}/qemu/${vm.vmid}/agent/exec`, {
        method: 'POST',
        params: { command: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script] }
      })
      await new Promise(res => setTimeout(res, 4000))
      const st = await apiElevated<{ exited: number; 'out-data'?: string; 'err-data'?: string }>(
        `/nodes/${vm.node}/qemu/${vm.vmid}/agent/exec-status`,
        { params: { pid: r.pid } }
      )
      if (st.exited && st['out-data']?.includes('RDP-READY')) {
        alert(`RDP is open on ${vm.name}. Download the RDP file and sign in as ${meta.user}.`)
      } else {
        alert(`Sent - ${vm.name} is applying it${st['err-data'] ? ` but reported: ${st['err-data'].slice(0, 200)}` : ' (give it a few seconds)'}.`)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      alert(
        `Couldn't reach inside ${vm.name}: ${detail}\n\n` +
        `Common causes: the QEMU guest agent isn't enabled on this VM's hardware config, ` +
        `the agent isn't installed/running inside the guest yet, or it's still booting. ` +
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
      {vm.lock && (
        <p className="machine-net snap-locked">
          <span className="error">🔒 Locked ({vm.lock}) - snapshots, restore, start and stop are blocked.</span>
          {isRoot
            ? <button className="small primary" onClick={unlockVm} disabled={unlocking}>
                {unlocking ? 'Unlocking…' : 'Unlock'}
              </button>
            : <span className="muted"> Ask an admin to clear it.</span>}
        </p>
      )}
      <p className="machine-net">
        {running
          ? ipResult.status === 'found'
            ? <>Address: <code>{ipResult.ip}</code></>
            : ipResult.status === 'no-agent'
              ? <span className="muted">Address: guest agent isn't enabled on this VM - ask an admin to turn it on.</span>
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
        {running && ipResult.status === 'found' && meta?.user && (
          <button className="primary" onClick={() => setShowRdp(true)}>
            Connect (RDP)
          </button>
        )}
        {running && meta?.user && isWindows && (
          <button onClick={openRdpAccess} disabled={rdpBusy}>{rdpBusy ? 'Opening…' : 'Open RDP access'}</button>
        )}
        {meta?.user && (
          <button className="small" onClick={() => setShowLogin(s => !s)}>{showLogin ? 'Hide login' : 'Show login'}</button>
        )}
        <button className="small" onClick={() => setShowSnaps(s => !s)}>Snapshots</button>
        {running && <button className="small" onClick={() => onAction(vm, 'shutdown')}>Turn off</button>}
        {running && <button className="small danger" onClick={() => onAction(vm, 'stop')}>Force off</button>}
        {running && (
          <button className="small console-link" onClick={() => setShowConsole(true)}>screen</button>
        )}
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

      {showConsole && vm.node && vm.vmid != null && (
        <Console
          node={vm.node}
          vmid={vm.vmid}
          name={vm.name}
          onClose={() => setShowConsole(false)}
          onAuthError={onAuthError}
        />
      )}

      {showRdp && vm.node && vm.vmid != null && (
        <RdpSession
          node={vm.node}
          vmid={vm.vmid}
          name={vm.name}
          onClose={() => setShowRdp(false)}
          onAuthError={onAuthError}
        />
      )}
    </div>
  )
}
