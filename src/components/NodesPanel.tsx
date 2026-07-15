import type { ClusterResource } from '../types'

const fmtBytes = (n?: number) => {
  if (!n || n <= 0) return '0'
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

function pct(used?: number, max?: number): number {
  if (!used || !max) return 0
  return Math.min(100, (used / max) * 100)
}

function tone(p: number): string {
  if (p >= 90) return 'critical'
  if (p >= 80) return 'warning'
  return 'good'
}

function Bar({ label, used, max }: { label: string; used?: number; max?: number }) {
  const p = pct(used, max)
  return (
    <div className="node-meter">
      <span className="node-meter-label">{label}</span>
      <div className="meter" role="meter" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`meter-fill ${tone(p)}`} style={{ width: `${p}%` }} />
      </div>
      <span className="node-meter-value">
        {Math.round(p)}%<span className="muted"> · {fmtBytes(used)}/{fmtBytes(max)}</span>
      </span>
    </div>
  )
}

/** Root-only infra view: hardware headroom per node, and per-storage usage. */
export default function NodesPanel({ resources, onClose }: { resources: ClusterResource[]; onClose: () => void }) {
  const nodes = resources
    .filter(r => r.type === 'node')
    .sort((a, b) => (a.node ?? '').localeCompare(b.node ?? ''))
  const storages = resources
    .filter(r => r.type === 'storage')
    .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>Nodes</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="cards">
          {nodes.map(n => (
            <div key={n.id} className={`card ${n.status !== 'online' ? 'node-down' : ''}`}>
              <div className="card-head">
                <span className={`dot ${n.status === 'online' ? 'dot-good' : 'dot-critical'}`} aria-hidden />
                <strong>{n.node}</strong>
                <span className={`pill ${n.status === 'online' ? 'pill-on' : 'pill-off'}`}>{n.status}</span>
              </div>
              <Bar label="CPU" used={(n.cpu ?? 0) * (n.maxcpu ?? 1)} max={n.maxcpu} />
              <Bar label="RAM" used={n.mem} max={n.maxmem} />
              <Bar label="Disk" used={n.disk} max={n.maxdisk} />
            </div>
          ))}
          {nodes.length === 0 && <p className="muted">No node data yet.</p>}
        </div>

        <h3 className="panel-subhead">Storage</h3>
        <div className="cards">
          {storages.map(s => (
            <div key={s.id} className="card">
              <div className="card-head">
                <strong>{s.storage}</strong>
                <span className="muted">on {s.node}{s.shared ? ' · shared' : ''}</span>
              </div>
              <Bar label="Used" used={s.disk} max={s.maxdisk} />
            </div>
          ))}
          {storages.length === 0 && <p className="muted">No storage data yet.</p>}
        </div>
      </div>
    </div>
  )
}
