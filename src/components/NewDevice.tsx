import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AuthError } from '../api'
import {
  androidApi,
  performanceLabel,
  runtimeLabel,
  type Catalog,
  type CompatibilityReport,
  type DeviceRequest,
  type Orientation,
  type PersistenceMode,
  type PlanResult
} from '../android'

/**
 * Create device.
 *
 * Basic mode asks four questions: what OS, what kind of device, what size,
 * what it is called. Advanced mode exposes the same request object's every
 * field - display, resources, runtime, network, persistence, features.
 *
 * Whatever mode you are in, the panel on the right is the scheduler's actual
 * answer, live: which node it would land on, which runtime, whether KVM is
 * there, and how fast it will really be. Nobody should have to wait ten
 * minutes for a boot to discover the ARM problem.
 */

const PERSISTENCE: Array<{ v: PersistenceMode; l: string }> = [
  { v: 'disposable', l: 'Disposable - thrown away when finished' },
  { v: 'persistent', l: 'Persistent - keeps its state' },
  { v: 'snapshot', l: 'Snapshot - keep a restore point' },
  { v: 'reset-on-release', l: 'Reset on release - handed back clean' }
]

export default function NewDevice({ catalog, onClose, onCreated, onAuthError }: {
  catalog: Catalog
  onClose: () => void
  onCreated: () => void
  onAuthError: () => void
}) {
  const [name, setName] = useState('')
  const [imageId, setImageId] = useState(catalog.images[0]?.id ?? '')
  const [formFactor, setFormFactor] = useState('')
  const [profileId, setProfileId] = useState('')
  const [advanced, setAdvanced] = useState(false)

  // Advanced overrides. Empty string means "leave it to the profile".
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [dpi, setDpi] = useState('')
  const [orientation, setOrientation] = useState<Orientation | ''>('')
  const [cpu, setCpu] = useState('')
  const [ram, setRam] = useState('')
  const [storage, setStorage] = useState('')
  const [runtime, setRuntime] = useState('')
  const [network, setNetwork] = useState('default')
  const [persistence, setPersistence] = useState<PersistenceMode>('disposable')
  const [features, setFeatures] = useState<Record<string, boolean>>({})

  const [plan, setPlan] = useState<PlanResult | null>(null)
  const [compat, setCompat] = useState<CompatibilityReport | null>(null)
  const [planning, setPlanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const image = catalog.images.find(i => i.id === imageId)

  // Only offer form factors this image actually has a build for.
  const factors = useMemo(
    () => catalog.formFactors.filter(f => !image || image.formFactors.includes(f.id)),
    [catalog.formFactors, image]
  )
  const profiles = useMemo(
    () => catalog.hardwareProfiles.filter(p => !formFactor || p.formFactor === formFactor),
    [catalog.hardwareProfiles, formFactor]
  )

  // Keep the shape choices coherent as the image changes underneath them.
  useEffect(() => {
    if (formFactor && factors.some(f => f.id === formFactor)) return
    setFormFactor(factors[0]?.id ?? '')
  }, [factors, formFactor])

  useEffect(() => {
    if (profileId && profiles.some(p => p.id === profileId)) return
    setProfileId(profiles[0]?.id ?? '')
  }, [profiles, profileId])

  const request: DeviceRequest = useMemo(() => {
    const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
    const display: Record<string, unknown> = {}
    if (num(width)) display.width = num(width)
    if (num(height)) display.height = num(height)
    if (num(dpi)) display.dpi = num(dpi)
    if (orientation) display.orientation = orientation
    const resources: Record<string, unknown> = {}
    if (num(cpu)) resources.cpu = num(cpu)
    if (num(ram)) resources.memoryMb = num(ram)
    if (num(storage)) resources.storageGb = num(storage)
    return {
      name: name.trim() || undefined,
      image: imageId,
      formFactor: formFactor || undefined,
      hardwareProfile: profileId || undefined,
      display: Object.keys(display).length ? display : undefined,
      resources: Object.keys(resources).length ? resources : undefined,
      features: Object.keys(features).length ? features : undefined,
      runtime: runtime || undefined,
      networkProfile: network,
      persistence
    }
  }, [name, imageId, formFactor, profileId, width, height, dpi, orientation, cpu, ram, storage, features, runtime, network, persistence])

  // Live plan, debounced. This is the scheduler's real answer, not a guess.
  useEffect(() => {
    if (!imageId) return
    let stop = false
    setPlanning(true)
    const t = setTimeout(() => {
      androidApi
        .plan(request)
        .then(r => {
          if (stop) return
          setPlan(r.plan)
          setCompat(r.compatibility)
        })
        .catch(err => {
          if (stop) return
          if (err instanceof AuthError) { onAuthError(); return }
          setPlan({ ok: false, reason: err instanceof Error ? err.message : String(err), detail: [] })
        })
        .finally(() => { if (!stop) setPlanning(false) })
    }, 350)
    return () => { stop = true; clearTimeout(t) }
  }, [request, imageId, onAuthError])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await androidApi.create(request)
      onCreated()
      onClose()
    } catch (err) {
      if (err instanceof AuthError) { onAuthError(); return }
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const toggleFeature = (key: string) =>
    setFeatures(f => ({ ...f, [key]: !f[key] }))

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal modal-wide" onSubmit={submit}>
        <div className="modal-head">
          <h2>Create device</h2>
          <div className="console-head-actions">
            <button type="button" className="adv-toggle" onClick={() => setAdvanced(a => !a)} aria-expanded={advanced}>
              {advanced ? '▾ Advanced' : '▸ Advanced'}
            </button>
            <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="device-create-body">
          <div className="device-create-form">
            <label>
              Name
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. till-layout-test"
                pattern="[A-Za-z0-9\-]*"
                title="Letters, digits and dashes only"
              />
            </label>

            <label>
              OS image
              <select value={imageId} onChange={e => setImageId(e.target.value)} required>
                {catalog.images.map(i => (
                  <option key={i.id} value={i.id}>
                    {i.name} - API {i.apiLevel} · {i.architecture}
                    {i.support !== 'supported' ? ` · ${i.support}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {image?.notes && <p className="machine-sub muted">{image.notes}</p>}

            <div className="grid2">
              <label>
                Device
                <select value={formFactor} onChange={e => setFormFactor(e.target.value)}>
                  {factors.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <label>
                Size
                <select value={profileId} onChange={e => setProfileId(e.target.value)}>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} - {p.display.width}×{p.display.height} @ {p.display.dpi}dpi
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {advanced && (
              <>
                <fieldset className="adv-options">
                  <legend>Display</legend>
                  <div className="grid2">
                    <label>Width<input type="number" min={64} max={7680} value={width} placeholder="from profile" onChange={e => setWidth(e.target.value)} /></label>
                    <label>Height<input type="number" min={64} max={7680} value={height} placeholder="from profile" onChange={e => setHeight(e.target.value)} /></label>
                    <label>DPI<input type="number" min={60} max={640} value={dpi} placeholder="from profile" onChange={e => setDpi(e.target.value)} /></label>
                    <label>
                      Orientation
                      <select value={orientation} onChange={e => setOrientation(e.target.value as Orientation | '')}>
                        <option value="">from profile</option>
                        <option value="portrait">Portrait</option>
                        <option value="landscape">Landscape</option>
                      </select>
                    </label>
                  </div>
                  <p className="machine-sub muted">
                    Any width, height and DPI are valid - 1920×480 at 160dpi is a perfectly ordinary request here.
                  </p>
                </fieldset>

                <fieldset className="adv-options">
                  <legend>Resources</legend>
                  <div className="grid2">
                    <label>CPU cores<input type="number" min={1} max={32} value={cpu} placeholder="auto" onChange={e => setCpu(e.target.value)} /></label>
                    <label>RAM (MB)<input type="number" min={512} max={65536} step={512} value={ram} placeholder="auto" onChange={e => setRam(e.target.value)} /></label>
                    <label>Storage (GB)<input type="number" min={2} max={512} value={storage} placeholder="auto" onChange={e => setStorage(e.target.value)} /></label>
                  </div>
                </fieldset>

                <fieldset className="adv-options">
                  <legend>Behaviour</legend>
                  <div className="grid2">
                    <label>
                      Runtime
                      <select value={runtime} onChange={e => setRuntime(e.target.value)}>
                        <option value="">Let ProxBox choose</option>
                        {catalog.runtimes.map(r => <option key={r} value={r}>{runtimeLabel(r)}</option>)}
                      </select>
                    </label>
                    <label>
                      Network
                      <select value={network} onChange={e => setNetwork(e.target.value)}>
                        {catalog.networks.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                      </select>
                    </label>
                    <label>
                      Persistence
                      <select value={persistence} onChange={e => setPersistence(e.target.value as PersistenceMode)}>
                        {PERSISTENCE.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="device-features">
                    {['gps', 'camera_front', 'camera_back', 'microphone', 'bluetooth', 'nfc', 'rotation', 'root'].map(k => (
                      <label key={k} className="inline-check">
                        <input type="checkbox" checked={!!features[k]} onChange={() => toggleFeature(k)} />
                        {k.replace(/_/g, ' ')}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
          </div>

          <aside className="device-plan">
            <h3 className="panel-subhead">
              What ProxBox will do {planning && <span className="spinner" aria-hidden />}
            </h3>

            {compat && (
              <dl className="device-facts">
                <dt>Runtime</dt><dd>{runtimeLabel(compat.runtime)}</dd>
                <dt>Boot</dt><dd>{compat.bootMethod}</dd>
                <dt>Architecture</dt><dd>{compat.architecture} on {compat.hostArchitecture} host</dd>
                <dt>KVM</dt>
                <dd>
                  {compat.kvm === 'required-available' ? 'Required - available'
                    : compat.kvm === 'required-unavailable' ? 'Required - NOT available'
                      : compat.kvm === 'unavailable-translated' ? 'Not usable - translated'
                        : 'Not required'}
                </dd>
                <dt>GPU</dt><dd>{compat.gpu}</dd>
                <dt>Performance</dt><dd>{performanceLabel(compat.performance)}</dd>
                <dt>Play services</dt><dd>{compat.playServices ? 'Yes' : 'No'}</dd>
              </dl>
            )}

            {plan?.ok && (
              <>
                <p className="good-note">✓ Lands on <strong>{plan.node}</strong>{plan.storage ? ` (${plan.storage})` : ''}</p>
                <ul className="device-reasons">
                  {plan.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                <p className="machine-sub muted">
                  {plan.display.width}×{plan.display.height} @ {plan.display.dpi}dpi ·
                  {' '}{plan.resources.cpu} cores · {Math.round(plan.resources.memoryMb / 1024)} GB RAM · {plan.resources.storageGb} GB
                </p>
              </>
            )}

            {plan && !plan.ok && (
              <>
                <p className="error" role="alert">⛔ {plan.reason}</p>
                {plan.detail.slice(0, 6).map((d, i) => <p key={i} className="machine-sub muted">{d}</p>)}
                {plan.suggestion && <p className="warn">{plan.suggestion}</p>}
              </>
            )}

            {compat?.warnings.map((w, i) => <p key={i} className="warn">⚠ {w}</p>)}
            {compat?.recommended && <p className="machine-sub muted">Recommended: {compat.recommended}</p>}
          </aside>
        </div>

        {error && <p className="error" role="alert">⚠ {error}</p>}

        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !plan?.ok}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
