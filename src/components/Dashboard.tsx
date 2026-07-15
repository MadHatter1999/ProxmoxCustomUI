import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiElevated, AuthError, type Session } from '../api'
import type { ClusterResource, TrackedTask } from '../types'
import { capacityLine } from '../placement'
import MachineCard from './MachineCard'
import NewMachine from './NewMachine'
import NodesPanel from './NodesPanel'
import TaskLog from './TaskLog'
import TechsPage from './TechsPage'
import UploadIso from './UploadIso'

export default function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const isRoot = session.username === 'root@pam'
  const [resources, setResources] = useState<ClusterResource[]>([])
  const [error, setError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showTechs, setShowTechs] = useState(false)
  const [showNodes, setShowNodes] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [tasks, setTasks] = useState<TrackedTask[]>([])
  const [refreshTick, setRefreshTick] = useState(0)

  const refresh = useCallback(() => setRefreshTick(t => t + 1), [])

  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const data = await apiElevated<ClusterResource[]>('/cluster/resources')
        if (!stop) { setResources(data); setError('') }
      } catch (err) {
        if (err instanceof AuthError) { onLogout(); return }
        if (!stop) setError(err instanceof Error ? err.message : String(err))
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [onLogout, refreshTick])

  const machines = useMemo(
    () =>
      resources
        .filter(r => r.type === 'qemu' && !r.template)
        .sort((a, b) => {
          if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
          return (a.name ?? '').localeCompare(b.name ?? '')
        }),
    [resources]
  )
  const liveCount = machines.filter(m => m.status === 'running').length

  const track = useCallback((upid: string, node: string, label: string) => {
    setTasks(ts => [...ts, { upid, node, label }])
  }, [])

  async function vmAction(vm: ClusterResource, action: 'start' | 'shutdown' | 'stop') {
    if (action === 'stop' && !confirm(`Force ${vm.name} off? Only do this if it's frozen - it's like yanking the power cord.`)) return
    try {
      const upid = await api<string>(`/nodes/${vm.node}/qemu/${vm.vmid}/status/${action}`, { method: 'POST' })
      track(upid, vm.node!, `${action === 'start' ? 'Starting' : action === 'shutdown' ? 'Turning off' : 'Force-stopping'} ${vm.name}`)
    } catch (err) {
      if (err instanceof AuthError) { onLogout(); return }
      alert(`Couldn't ${action} ${vm.name}: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <strong>The Proxbox</strong>
        </div>
        <div className="topbar-actions">
          <button className="primary" onClick={() => setShowNew(true)}>+ New machine</button>
          <button onClick={() => setShowUpload(true)}>Upload ISO</button>
          {isRoot && <button onClick={() => setShowNodes(true)}>Nodes</button>}
          {isRoot && <button onClick={() => setShowTechs(true)}>Techs</button>}
          <span className="muted">{session.username}</span>
          <button className="ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <p className="capacity-line muted">{resources.length ? capacityLine(resources) : 'Checking The Proxbox…'}</p>

      {error && <p className="error banner" role="alert">⚠ Can't reach The Proxbox right now: {error}</p>}

      <section>
        <h2>Machines {machines.length > 0 && <span className="muted">({liveCount} live)</span>}</h2>
        <div className="cards">
          {machines.map(vm => (
            <MachineCard key={vm.id} vm={vm} onAction={vmAction} onTask={track} />
          ))}
          {machines.length === 0 && !error && <p className="muted">No machines yet - spin one up.</p>}
        </div>
      </section>

      {tasks.length > 0 && (
        <div className="task-tray">
          {tasks.map(t => (
            <TaskLog
              key={t.upid}
              task={t}
              onDone={refresh}
              onDismiss={() => setTasks(ts => ts.filter(x => x.upid !== t.upid))}
            />
          ))}
        </div>
      )}

      {showNew && (
        <NewMachine
          resources={resources}
          username={session.username}
          onClose={() => setShowNew(false)}
          onTask={(upid, node, label) => { track(upid, node, label); setShowNew(false) }}
          onAuthError={onLogout}
        />
      )}

      {showTechs && isRoot && <TechsPage onClose={() => setShowTechs(false)} />}

      {showNodes && isRoot && <NodesPanel resources={resources} onClose={() => setShowNodes(false)} />}

      {showUpload && (
        <UploadIso
          onClose={() => setShowUpload(false)}
          onTask={(upid, node, label) => { track(upid, node, label); setShowUpload(false) }}
          onAuthError={onLogout}
        />
      )}
    </div>
  )
}
