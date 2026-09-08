import { useState } from 'react'
import { AuthError } from '../api'
import { androidApi, runtimeLabel, stateLabel, type AndroidDevice } from '../android'

/**
 * One Android device, virtual or physical, on one card.
 *
 * There is deliberately no branch on kind here beyond a label and which actions
 * make sense: if this component ever needs to know "is this really a tablet or
 * an emulator", the abstraction underneath has failed.
 */
export default function DeviceCard({ device, username, onOpen, onChanged, onAuthError }: {
  device: AndroidDevice
  username: string
  onOpen: () => void
  onChanged: () => void
  onAuthError: () => void
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const ready = device.state === 'ready'
  const held = device.reservation
  const mine = held?.owner === username
  const blocked = !!held && !mine

  async function act(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return
    setBusy(label)
    setError('')
    try {
      await fn()
      onChanged()
    } catch (err) {
      if (err instanceof AuthError) { onAuthError(); return }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const tone =
    device.state === 'ready' ? 'dot-good'
      : device.state === 'error' || device.state === 'offline' ? 'dot-critical'
        : 'dot-muted'

  return (
    <div className={`card machine-card ${device.state === 'offline' ? 'node-down' : ''}`}>
      <div className="card-head">
        <span className={`dot ${tone}`} aria-hidden />
        <strong>{device.name}</strong>
        <span className={`pill ${ready ? 'pill-on' : 'pill-off'}`}>{stateLabel[device.state]}</span>
      </div>

      <p className="machine-sub muted">
        Android {device.androidVersion} · {device.formFactor.replace(/_/g, ' ')} · {device.display.width}×{device.display.height} @ {device.display.dpi}dpi
      </p>
      <p className="machine-sub muted">
        {device.architecture} · {device.kind === 'physical' ? 'Physical' : 'Virtual'} · {runtimeLabel(device.runtime)} · {device.node}
        {device.adb.serial ? ` · ${device.adb.serial}` : ''}
      </p>

      {held && (
        <p className="machine-net">
          {mine ? 'Held by you' : `In use by ${held.owner}`}
          {held.expiresAt ? ` until ${new Date(held.expiresAt).toLocaleTimeString()}` : ''}
        </p>
      )}
      {!held && ready && <p className="machine-net">Available</p>}
      {device.statusText && <p className="machine-sub muted">{device.statusText}</p>}
      {device.error && <p className="error" role="alert">⚠ {device.error}</p>}
      {error && <p className="error" role="alert">⚠ {error}</p>}

      <div className="machine-actions">
        <button className="primary" onClick={onOpen} disabled={blocked}>Open</button>

        {device.kind === 'virtual' && device.state === 'stopped' && (
          <button disabled={!!busy} onClick={() => act('start', () => androidApi.action(device.id, 'start'))}>
            {busy === 'start' ? 'Starting…' : 'Start'}
          </button>
        )}
        {device.kind === 'virtual' && ready && (
          <button disabled={!!busy || blocked} onClick={() => act('stop', () => androidApi.action(device.id, 'stop'))}>
            {busy === 'stop' ? 'Stopping…' : 'Turn off'}
          </button>
        )}
        {ready && (
          <button disabled={!!busy || blocked} onClick={() => act('reboot', () => androidApi.action(device.id, 'reboot'))}>
            Reboot
          </button>
        )}
        {ready && (
          <button
            disabled={!!busy || blocked}
            onClick={() =>
              act(
                'reset',
                () => androidApi.action(device.id, 'reset'),
                device.kind === 'physical'
                  ? `Factory-reset ${device.name}? This wipes the actual hardware and cannot be undone.`
                  : `Wipe ${device.name} back to its base image? Everything on it is thrown away.`
              )
            }
          >
            Reset
          </button>
        )}

        {held && mine && (
          <button disabled={!!busy} onClick={() => act('release', () => androidApi.release(device.id))}>
            Release
          </button>
        )}
        {!held && (
          <button disabled={!!busy} onClick={() => act('reserve', () => androidApi.reserve(device.id))}>
            Reserve
          </button>
        )}

        {device.kind === 'virtual' && (
          <button
            className="ghost"
            disabled={!!busy || blocked}
            onClick={() =>
              act('destroy', () => androidApi.destroy(device.id), `Destroy ${device.name}? The device and its disk are removed.`)
            }
          >
            {busy === 'destroy' ? 'Removing…' : 'Destroy'}
          </button>
        )}
      </div>
    </div>
  )
}
