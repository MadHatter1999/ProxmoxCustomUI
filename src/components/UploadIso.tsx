import { useRef, useState, type FormEvent } from 'react'
import { AuthError, uploadFile } from '../api'
import { pickIsoTarget } from '../placement'
import type { ClusterResource } from '../types'

const GB = 1024 ** 3
const WARN_PCT = 80
const BLOCK_PCT = 90

export default function UploadIso({ resources, onClose, onTask, onAuthError }: {
  resources: ClusterResource[]
  onClose: () => void
  onTask: (upid: string, node: string, label: string) => void
  onAuthError: () => void
}) {
  const target = pickIsoTarget(resources)
  const [file, setFile] = useState<File | null>(null)
  const [override, setOverride] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Recompute the post-upload usage directly from bytes (freeBytes + pctUsed
  // together imply the storage's total size) rather than approximating.
  const willFit = (() => {
    if (!target || !file) return { pct: target?.pctUsed ?? 0, blocked: false }
    const totalBytes = target.freeBytes / (1 - target.pctUsed / 100 || 1)
    const usedAfter = totalBytes * (target.pctUsed / 100) + file.size
    const pctNow = (usedAfter / totalBytes) * 100
    return { pct: pctNow, blocked: pctNow >= BLOCK_PCT && !override }
  })()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!target || !file) return
    if (willFit.blocked) return
    setPct(0)
    try {
      const upid = await uploadFile(target.node, target.storage, 'iso', file, setPct)
      onTask(upid, target.node, `Uploading ${file.name}`)
      onClose()
    } catch (err) {
      if (err instanceof AuthError) { onAuthError(); return }
      setError(err instanceof Error ? err.message : String(err))
      setPct(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && pct === null) onClose() }}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>Upload an image</h2>
          {pct === null && <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>}
        </div>

        <p className="muted">
          Adds to the shared image folder everyone picks from when spinning up a machine.
        </p>

        {!target && <p className="error" role="alert">⛔ No image storage is reachable right now - try again shortly.</p>}

        {target && (
          <>
            <label>
              ISO file
              <input
                ref={inputRef}
                type="file"
                accept=".iso"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                disabled={pct !== null}
                required
              />
            </label>

            {file && (
              <p className="muted">
                {file.name} - {(file.size / GB).toFixed(2)} GB
              </p>
            )}

            {file && willFit.pct >= WARN_PCT && (
              <p className={willFit.pct >= BLOCK_PCT ? 'error' : 'warn'} role="alert">
                {willFit.pct >= BLOCK_PCT ? '⛔' : '⚠'} This would leave the image storage {Math.round(willFit.pct)}% full.
                {willFit.pct >= BLOCK_PCT
                  ? ' That is how the lab ran out of space before - pick a smaller file or free something up first.'
                  : ' Consider clearing out unused images first.'}
                {willFit.pct >= BLOCK_PCT && (
                  <label className="inline-check">
                    <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} />
                    I understand, upload anyway
                  </label>
                )}
              </p>
            )}

            {pct !== null && (
              <div className="upload-progress">
                <div className="upload-progress-fill" style={{ width: `${pct}%` }} />
                <span className="upload-progress-label">{pct}%</span>
              </div>
            )}
          </>
        )}

        {error && <p className="error" role="alert">⚠ {error}</p>}

        <div className="modal-foot">
          <button type="button" className="ghost" onClick={onClose} disabled={pct !== null && pct < 100}>
            {pct !== null && pct < 100 ? 'Uploading…' : 'Cancel'}
          </button>
          <button type="submit" className="primary" disabled={!target || !file || pct !== null || willFit.blocked}>
            Upload
          </button>
        </div>
      </form>
    </div>
  )
}
