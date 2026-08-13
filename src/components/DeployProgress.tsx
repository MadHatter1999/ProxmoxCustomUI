import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiElevated, type DeployJob } from '../api'

/**
 * Full-screen "please wait" while a WIM deploys onto a new VM. We can't see
 * DISM's exact percentage from out here, so the bar is time-based against an
 * estimate from the image size, and we detect the real milestones by watching
 * the VM: while it's still booted off the WinPE CD it's applying; once the
 * server has stripped that CD and set it to boot from disk, it's done.
 */
export default function DeployProgress({ job, name, imageName, sizeGb, onDone }: {
  job: DeployJob
  name: string
  imageName: string
  sizeGb: number
  onDone: () => void
}) {
  const etaSec = Math.min(45 * 60, Math.max(180, Math.round(sizeGb * 30))) // ~30s per GB, clamped 3–45 min
  const [elapsed, setElapsed] = useState(0)
  const [phase, setPhase] = useState<'applying' | 'finishing' | 'ready'>('applying')
  const startedRef = useRef(Date.now())

  // tick the clock every second for the countdown + bar
  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedRef.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  // poll the VM to find the real milestones
  useEffect(() => {
    let stop = false
    async function poll() {
      try {
        const cfg = await apiElevated<{ ide2?: string }>(`/nodes/${job.node}/qemu/${job.vmid}/config`)
        if (stop) return
        if (!cfg.ide2 || cfg.ide2.startsWith('none')) {
          // WinPE CD stripped by the server → deploy finished, booting from disk
          const st = await apiElevated<{ status?: string }>(`/nodes/${job.node}/qemu/${job.vmid}/status/current`)
          if (stop) return
          setPhase(st.status === 'running' ? 'ready' : 'finishing')
        }
      } catch { /* transient - keep polling */ }
      if (!stop) setTimeout(poll, 5000)
    }
    poll()
    return () => { stop = true }
  }, [job.node, job.vmid])

  const remaining = Math.max(0, etaSec - elapsed)
  const mins = Math.floor(remaining / 60)
  const pct =
    phase === 'ready' ? 100 :
    phase === 'finishing' ? 97 :
    Math.min(95, Math.round((elapsed / etaSec) * 100))

  const heading =
    phase === 'ready' ? 'Ready' :
    phase === 'finishing' ? 'Finishing up…' :
    'Building your machine…'
  const sub =
    phase === 'ready' ? `${name} is up and booting into Windows.` :
    phase === 'finishing' ? 'Image applied - making it bootable and cleaning up.' :
    `Applying ${imageName} to ${name}. You can leave this open; it keeps working if you don't.`

  return createPortal(
    <div className="modal-backdrop">
      <div className="modal deploy-modal">
        <div className="deploy-body">
          {phase === 'ready'
            ? <div className="deploy-check" aria-hidden>✓</div>
            : <div className="deploy-spinner" aria-hidden />}
          <h2>{heading}</h2>
          <p className="muted">{sub}</p>

          <div className="deploy-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`deploy-bar-fill ${phase === 'ready' ? 'done' : ''}`} style={{ width: `${pct}%` }} />
          </div>

          <p className="deploy-eta muted">
            {phase === 'ready'
              ? 'Done'
              : phase === 'finishing'
                ? 'Almost there…'
                : remaining > 0
                  ? `About ${mins > 0 ? `${mins} min` : `${remaining}s`} remaining · ${pct}%`
                  : `Wrapping up… · ${pct}%`}
          </p>

          <div className="modal-foot">
            <button
              type="button"
              className={phase === 'ready' ? 'primary' : 'ghost'}
              onClick={onDone}
            >
              {phase === 'ready' ? 'Done' : 'Run in background'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
