import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { AuthError } from '../api'
import { androidApi, type AndroidDevice } from '../android'

/**
 * The remote-control surface, shared by every kind of Android device.
 *
 * The screen is a polled image and input goes back as taps, swipes and key
 * events. That is deliberately the LOWEST common denominator: it works on a
 * physical Zebra scanner, a Bliss OS VM and a headless emulator without any of
 * them knowing about the others, and it needs no codec support in the browser
 * and no second websocket in a server whose upgrade path has already been
 * broken once. docs/android/remote-control.md sets out the H.264 upgrade that
 * slots in behind this same component when it is worth doing.
 */

const KEYS: Array<{ label: string; code: string; title: string }> = [
  { label: '◀', code: 'KEYCODE_BACK', title: 'Back' },
  { label: '●', code: 'KEYCODE_HOME', title: 'Home' },
  { label: '■', code: 'KEYCODE_APP_SWITCH', title: 'Recents' },
  { label: '⏻', code: 'KEYCODE_POWER', title: 'Power' },
  { label: '🔉', code: 'KEYCODE_VOLUME_DOWN', title: 'Volume down' },
  { label: '🔊', code: 'KEYCODE_VOLUME_UP', title: 'Volume up' }
]

/** Browser keys that map onto Android keycodes. Everything else goes as text. */
const KEY_MAP: Record<string, string> = {
  Backspace: 'KEYCODE_DEL',
  Enter: 'KEYCODE_ENTER',
  Tab: 'KEYCODE_TAB',
  Escape: 'KEYCODE_BACK',
  ArrowUp: 'KEYCODE_DPAD_UP',
  ArrowDown: 'KEYCODE_DPAD_DOWN',
  ArrowLeft: 'KEYCODE_DPAD_LEFT',
  ArrowRight: 'KEYCODE_DPAD_RIGHT'
}

export default function DeviceScreen({ device, onClose, onChanged, onAuthError }: {
  device: AndroidDevice
  onClose: () => void
  onChanged: () => void
  onAuthError: () => void
}) {
  const [frame, setFrame] = useState(0)
  const [live, setLive] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [shellOpen, setShellOpen] = useState(false)
  const [shellCmd, setShellCmd] = useState('')
  const [shellOut, setShellOut] = useState('')
  const [installPct, setInstallPct] = useState<number | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const ready = device.state === 'ready'

  // One frame at a time: the next request only goes out when the last image
  // has actually painted, so a slow device degrades to a lower frame rate
  // instead of queueing up a backlog of stale screenshots.
  useEffect(() => {
    if (!live || !ready) return
    const t = setTimeout(() => setFrame(f => f + 1), 450)
    return () => clearTimeout(t)
  }, [live, ready, frame])

  const handle = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label)
      setError('')
      try {
        await fn()
      } catch (err) {
        if (err instanceof AuthError) { onAuthError(); return }
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy('')
      }
    },
    [onAuthError]
  )

  /** Screen pixel -> device pixel, using the image's own natural size. */
  function toDevice(e: ReactPointerEvent<HTMLImageElement>): { x: number; y: number } {
    const img = imgRef.current
    if (!img) return { x: 0, y: 0 }
    const rect = img.getBoundingClientRect()
    const natW = img.naturalWidth || device.display.width
    const natH = img.naturalHeight || device.display.height
    return {
      x: ((e.clientX - rect.left) / rect.width) * natW,
      y: ((e.clientY - rect.top) / rect.height) * natH
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    if (!ready) return
    const p = toDevice(e)
    pressRef.current = { ...p, at: Date.now() }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLImageElement>) {
    if (!ready || !pressRef.current) return
    const start = pressRef.current
    pressRef.current = null
    const end = toDevice(e)
    const dist = Math.hypot(end.x - start.x, end.y - start.y)
    const ms = Date.now() - start.at
    // A drag is a swipe; anything that barely moved is a tap. 12 device pixels
    // is about a fingertip's worth of wobble on a mouse.
    const body =
      dist > 12
        ? { type: 'swipe', x: start.x, y: start.y, x2: end.x, y2: end.y, ms: Math.max(80, Math.min(1200, ms)) }
        : { type: 'tap', x: end.x, y: end.y }
    handle('', () => androidApi.input(device.id, body)).then(() => setFrame(f => f + 1))
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (!ready) return
    const mapped = KEY_MAP[e.key]
    if (mapped) {
      e.preventDefault()
      handle('', () => androidApi.input(device.id, { type: 'key', keycode: mapped }))
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      handle('', () => androidApi.input(device.id, { type: 'text', value: e.key }))
    }
  }

  async function rotate() {
    const next = device.display.orientation === 'landscape' ? 'portrait' : 'landscape'
    await handle('Rotating', () => androidApi.setDisplay(device.id, { orientation: next }))
    onChanged()
    setFrame(f => f + 1)
  }

  async function runShell() {
    const cmd = shellCmd.trim()
    if (!cmd) return
    setShellOut(o => `${o}\n$ ${cmd}\n`)
    setShellCmd('')
    await handle('Running', async () => {
      const r = await androidApi.shell(device.id, cmd)
      setShellOut(o => `${o}${r.output}\n`)
    })
  }

  async function installApk(file: File) {
    setInstallPct(0)
    await handle('Installing', async () => {
      const out = await androidApi.installApk(device.id, file, setInstallPct)
      setShellOpen(true)
      setShellOut(o => `${o}\n$ install ${file.name}\n${out}\n`)
    })
    setInstallPct(null)
    setFrame(f => f + 1)
  }

  const portrait = device.display.height >= device.display.width

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-wide device-screen-modal">
        <div className="modal-head">
          <h2>{device.name}</h2>
          <div className="console-head-actions">
            <span className="muted">
              Android {device.androidVersion} · {device.display.width}×{device.display.height} @ {device.display.dpi}dpi · {device.node}
            </span>
            <button type="button" className="ghost" onClick={() => setLive(l => !l)}>
              {live ? 'Pause' : 'Resume'}
            </button>
            <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {error && <p className="error banner" role="alert">⚠ {error}</p>}
        {!ready && (
          <p className="warn">
            {device.statusText ?? `This device is ${device.state}.`} The screen appears once Android has finished booting.
          </p>
        )}

        <div className="device-screen-body">
          <div
            className={`device-screen-stage ${portrait ? 'portrait' : 'landscape'}`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            role="application"
            aria-label={`${device.name} screen`}
          >
            {ready ? (
              <img
                ref={imgRef}
                className="device-screen-img"
                src={androidApi.screenUrl(device.id, frame)}
                alt=""
                draggable={false}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onError={() => setLive(false)}
              />
            ) : (
              <div className="device-screen-placeholder">
                <span className="spinner" aria-hidden /> {device.statusText ?? device.state}
              </div>
            )}
          </div>

          <div className="device-screen-side">
            <div className="device-keys">
              {KEYS.map(k => (
                <button
                  key={k.code}
                  type="button"
                  title={k.title}
                  disabled={!ready}
                  onClick={() => handle('', () => androidApi.input(device.id, { type: 'key', keycode: k.code }))}
                >
                  {k.label}
                </button>
              ))}
            </div>

            <div className="device-tools">
              <button type="button" disabled={!ready} onClick={rotate}>Rotate</button>
              <a
                className="button-like"
                href={androidApi.screenUrl(device.id, frame)}
                download={`${device.name}.png`}
              >
                Screenshot
              </a>
              <button type="button" disabled={!ready} onClick={() => fileRef.current?.click()}>
                Install APK
              </button>
              <button type="button" onClick={() => setShellOpen(s => !s)}>
                {shellOpen ? 'Hide shell' : 'ADB shell'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".apk"
                hidden
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) installApk(f)
                  e.target.value = ''
                }}
              />
            </div>

            {installPct !== null && (
              <div className="upload-progress">
                <div className="upload-progress-fill" style={{ width: `${installPct}%` }} />
                <span className="upload-progress-label">Uploading APK {installPct}%</span>
              </div>
            )}

            <dl className="device-facts">
              <dt>Runtime</dt><dd>{device.runtime}</dd>
              <dt>ADB</dt><dd>{device.adb.serial ?? 'not attached'}</dd>
              <dt>Held by</dt><dd>{device.reservation?.owner ?? 'nobody'}</dd>
              {busy && <><dt>Busy</dt><dd>{busy}…</dd></>}
            </dl>
          </div>
        </div>

        {shellOpen && (
          <div className="device-shell">
            <pre className="task-log" aria-live="polite">{shellOut || 'adb shell - type a command below. Everything you run here is written to the audit log.'}</pre>
            <form
              className="device-shell-input"
              onSubmit={e => { e.preventDefault(); runShell() }}
            >
              <input
                value={shellCmd}
                onChange={e => setShellCmd(e.target.value)}
                placeholder="pm list packages -3"
                disabled={!ready}
              />
              <button type="submit" className="primary" disabled={!ready || !shellCmd.trim()}>Run</button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
