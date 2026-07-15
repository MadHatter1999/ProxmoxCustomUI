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

  useEffect(() => {
    let stop = false
    let rfb: RFB | null = null

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

        rfb = new RFB(screenRef.current, wsUrl, { credentials: { password: info.ticket } })
        rfb.scaleViewport = true
        rfb.resizeSession = true
        rfb.addEventListener('connect', () => { if (!stop) setStatus('connected') })
        rfb.addEventListener('disconnect', () => { if (!stop) setStatus('disconnected') })
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
  }, [node, vmid, onAuthError])

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-console">
        <div className="modal-head">
          <h2>{name ?? `VM ${vmid}`} - screen</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="console-status muted">
          {status === 'connecting' && <><span className="spinner" aria-hidden /> Connecting…</>}
          {status === 'connected' && 'Connected'}
          {status === 'disconnected' && 'Disconnected'}
          {status === 'error' && <span className="error">⚠ {error || 'Could not connect'}</span>}
        </div>

        <div className="console-screen" ref={screenRef} />
      </div>
    </div>
  )
}
