import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthError } from '../api'
import { androidApi, type AndroidDevice, type Catalog, type NodeCapabilities } from '../android'
import DeviceCard from './DeviceCard'
import DeviceScreen from './DeviceScreen'
import NewDevice from './NewDevice'

/**
 * The Devices section.
 *
 * It sits alongside Machines in the existing ProxBox shell rather than being a
 * second app, and it shows every Android device the lab has - the emulator that
 * was created ninety seconds ago and the tablet that has been on pve6's USB
 * port for a month - in one list, with one set of actions.
 */

const POLL_MS = 4000

export default function DevicesPanel({ username, onClose, onAuthError }: {
  username: string
  onClose: () => void
  onAuthError: () => void
}) {
  const [devices, setDevices] = useState<AndroidDevice[]>([])
  const [nodes, setNodes] = useState<NodeCapabilities[]>([])
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showNodes, setShowNodes] = useState(false)
  const [filter, setFilter] = useState<'all' | 'virtual' | 'physical' | 'available'>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const [d, n] = await Promise.all([androidApi.devices(), androidApi.nodes()])
        if (stop) return
        setDevices(d)
        setNodes(n)
        setError('')
        setLoaded(true)
      } catch (err) {
        if (stop) return
        if (err instanceof AuthError) { onAuthError(); return }
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      }
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [onAuthError, tick])

  // The catalogue barely changes; fetch it once when the panel opens.
  useEffect(() => {
    let stop = false
    androidApi
      .catalog()
      .then(c => { if (!stop) setCatalog(c) })
      .catch(err => {
        if (stop) return
        if (err instanceof AuthError) onAuthError()
      })
    return () => { stop = true }
  }, [onAuthError])

  const counts = useMemo(() => {
    const ready = devices.filter(d => d.state === 'ready')
    return {
      total: devices.length,
      physical: devices.filter(d => d.kind === 'physical').length,
      virtual: devices.filter(d => d.kind === 'virtual').length,
      available: ready.filter(d => !d.reservation).length,
      inUse: devices.filter(d => d.reservation).length
    }
  }, [devices])

  const shown = useMemo(() => {
    switch (filter) {
      case 'virtual': return devices.filter(d => d.kind === 'virtual')
      case 'physical': return devices.filter(d => d.kind === 'physical')
      case 'available': return devices.filter(d => d.state === 'ready' && !d.reservation)
      default: return devices
    }
  }, [devices, filter])

  const open = devices.find(d => d.id === openId) ?? null
  const agentsUp = nodes.filter(n => n.reachable).length

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>Devices</h2>
          <div className="console-head-actions">
            <button className="primary" onClick={() => setShowNew(true)} disabled={!catalog}>+ Create device</button>
            <button onClick={() => setShowNodes(s => !s)}>{showNodes ? 'Hide nodes' : 'Nodes'}</button>
            <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {error && <p className="error banner" role="alert">⚠ {error}</p>}

        <div className="device-counts">
          <button className={`seg ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            <strong>{counts.total}</strong> Android
          </button>
          <button className={`seg ${filter === 'virtual' ? 'on' : ''}`} onClick={() => setFilter('virtual')}>
            <strong>{counts.virtual}</strong> Virtual
          </button>
          <button className={`seg ${filter === 'physical' ? 'on' : ''}`} onClick={() => setFilter('physical')}>
            <strong>{counts.physical}</strong> Physical
          </button>
          <button className={`seg ${filter === 'available' ? 'on' : ''}`} onClick={() => setFilter('available')}>
            <strong>{counts.available}</strong> Available
          </button>
          <span className="seg static"><strong>{counts.inUse}</strong> In use</span>
        </div>

        {showNodes && (
          <>
            <h3 className="panel-subhead">Nodes running the Android agent</h3>
            <div className="cards">
              {nodes.map(n => (
                <div key={n.node} className={`card ${n.reachable ? '' : 'node-down'}`}>
                  <div className="card-head">
                    <span className={`dot ${n.reachable ? 'dot-good' : 'dot-critical'}`} aria-hidden />
                    <strong>{n.node}</strong>
                    <span className="muted">{n.cpuModel ?? n.arch}</span>
                  </div>
                  <p className="machine-sub muted">
                    {n.cores} cores · {Math.round(n.freeRamMb / 1024)} / {Math.round(n.ramMb / 1024)} GB free
                  </p>
                  <p className="machine-sub muted">
                    KVM {n.kvm ? 'yes' : 'no'} · nested {n.nestedKvm ? 'yes' : 'no'} · GPU {n.gpu?.opengl ? (n.gpu.model ?? 'yes') : 'no'}
                  </p>
                  <p className="machine-sub muted">
                    Runtimes: {Object.entries(n.runtimes).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}
                  </p>
                  <p className="machine-sub muted">
                    USB host {n.usbHost ? 'yes' : 'no'} · {n.physical.length} device{n.physical.length === 1 ? '' : 's'} attached · {n.cachedImages.length} images staged
                  </p>
                </div>
              ))}
              {!nodes.length && (
                <p className="muted">
                  No node is running the Android agent yet. Install it with <code>agent/install-android-agent.sh</code> -
                  until then this section can show a catalogue but cannot build anything.
                </p>
              )}
            </div>
          </>
        )}

        <h3 className="panel-subhead">
          {filter === 'all' ? 'All devices' : filter === 'available' ? 'Available now' : `${filter} devices`}
        </h3>
        <div className="cards">
          {shown.map(d => (
            <DeviceCard
              key={d.id}
              device={d}
              username={username}
              onOpen={() => setOpenId(d.id)}
              onChanged={refresh}
              onAuthError={onAuthError}
            />
          ))}
          {loaded && !shown.length && (
            <p className="muted">
              {devices.length
                ? 'Nothing matches that filter.'
                : agentsUp
                  ? 'No Android devices yet - create one, or plug a tablet into a node.'
                  : 'No Android devices, and no node agents reporting in.'}
            </p>
          )}
        </div>

        {showNew && catalog && (
          <NewDevice
            catalog={catalog}
            onClose={() => setShowNew(false)}
            onCreated={refresh}
            onAuthError={onAuthError}
          />
        )}

        {open && (
          <DeviceScreen
            device={open}
            onClose={() => setOpenId(null)}
            onChanged={refresh}
            onAuthError={onAuthError}
          />
        )}
      </div>
    </div>
  )
}
