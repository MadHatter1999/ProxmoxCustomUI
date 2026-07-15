import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { apiElevated, AuthError } from '../api'

interface VncProxyInfo {
  ticket: string
  port: string
}

type Status = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function Console({ node, vmid, name, onClose, onAuthError }: {
  node: string
  vmid: number
  name?: string
  onClose: () => void
  onAuthError: () => void
}) {
  const screenRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let stop = false
    let rfb: RFB | null = null
    setStatus('connecting')
    setError('')

    async function connect() {
      try {
        // Elevated: works the same for a tech login as it does for root,
        // same reasoning as every other VM action in this app.
        const info = await apiElevated<VncProxyInfo>(`/nodes/${node}/qemu/${vmid}/vncproxy`, {
          method: 'POST',
          params: { websocket: 1 }
        })
        if (stop || !screenRef.current) return

        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        const wsUrl = `${proto}://${location.host}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${info.port}&vncticket=${encodeURIComponent(info.ticket)}`

        // Proxmox's websocket proxy specifically negotiates the "binary"
        // subprotocol - without requesting it, the RFB handshake on top of
        // the websocket fails and the connection drops right away.
        rfb = new RFB(screenRef.current, wsUrl, {
          credentials: { password: info.ticket },
          wsProtocols: ['binary']
        })
        // scaleViewport fits the existing framebuffer to the window.
        // resizeSession (asking the *guest* to change resolution) fights
        // with that and isn't supported by most guests anyway - leave off.
        rfb.scaleViewport = true
        rfb.addEventListener('connect', () => { if (!stop) setStatus('connected') })
        rfb.addEventListener('disconnect', (e: CustomEvent<{ clean?: boolean }>) => {
          if (stop) return
          if (e.detail?.clean === false) {
            setStatus('error')
            setError('Lost the connection unexpectedly - the console session may have expired.')
          } else {
            setStatus('disconnected')
          }
        })
        rfb.addEventListener('securityfailure', (e: CustomEvent<{ reason?: string }>) => {
          if (stop) return
          setStatus('error')
          setError(e.detail?.reason ?? 'The console rejected the connection')
        })
      } catch (err) {
        if (stop) return
        if (err instanceof AuthError) { onAuthError(); return }
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    connect()

    return () => {
      stop = true
      rfb?.disconnect()
    }
  }, [node, vmid, onAuthError, attempt])

  const showOverlay = status !== 'connected'

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-console">
        <div className="modal-head">
          <h2>{name ?? `VM ${vmid}`} <span className="muted">- screen</span></h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="console-screen">
          <div className="console-canvas" ref={screenRef} />
          {showOverlay && (
            <div className="console-overlay">
              {status === 'connecting' && <><span className="spinner" aria-hidden /> Connecting…</>}
              {status === 'disconnected' && 'Disconnected'}
              {status === 'error' && (
                <>
                  <span className="error">⚠ {error || 'Could not connect'}</span>
                  <button type="button" onClick={() => setAttempt(a => a + 1)}>Retry</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
