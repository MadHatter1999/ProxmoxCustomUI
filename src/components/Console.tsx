import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import RFB from '@novnc/novnc'
import { api, AuthError } from '../api'

interface VncProxyInfo {
  ticket: string
  password: string
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
  const screenBoxRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === screenBoxRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      screenBoxRef.current?.requestFullscreen().catch(() => {
        setError('This browser blocked fullscreen - try again or use its own fullscreen shortcut.')
      })
    }
  }

  useEffect(() => {
    let stop = false
    let rfb: RFB | null = null
    setStatus('connecting')
    setError('')

    async function connect() {
      try {
        // NOT elevated, deliberately: Proxmox scopes a VNC ticket to the
        // exact identity that minted it. The websocket itself connects
        // straight from the browser using its own session cookie (via the
        // plain /api2 proxy, not the root-token /svc/pve one) - minting the
        // ticket under a different identity (root's token) makes Proxmox
        // reject it as invalid the moment the websocket tries to redeem it.
        // No elevation needed anyway: VM.Console is already in PVEVMAdmin.
        const info = await api<VncProxyInfo>(`/nodes/${node}/qemu/${vmid}/vncproxy`, {
          method: 'POST',
          params: { websocket: 1 }
        })
        if (stop || !screenRef.current) return

        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        const wsUrl = `${proto}://${location.host}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${info.port}&vncticket=${encodeURIComponent(info.ticket)}`

        // vncproxy returns two different values: `ticket` (long, structured)
        // authorizes the websocket itself via the vncticket query param;
        // `password` (short) is the actual RFB/VNC-auth password. Using the
        // ticket for both looks plausible but fails the RFB security
        // handshake silently - Proxmox just drops the connection.
        rfb = new RFB(screenRef.current, wsUrl, {
          credentials: { password: info.password },
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

  // Portalled to <body>: MachineCard (this component's caller) has class
  // "card", which sets backdrop-filter - and backdrop-filter, like transform
  // or filter, makes its element the containing block for any position:fixed
  // descendant. Without the portal, "fixed, full-viewport" backdrop would
  // actually be pinned to that small card instead of the screen.
  return createPortal(
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-console">
        <div className="modal-head">
          <h2>{name ?? `VM ${vmid}`} <span className="muted">- screen</span></h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="console-screen" ref={screenBoxRef}>
          <div className="console-canvas" ref={screenRef} />
          <button
            type="button"
            className="small console-fullscreen-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {isFullscreen ? '⤡ Exit fullscreen' : '⛶ Fullscreen'}
          </button>
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
    </div>,
    document.body
  )
}
