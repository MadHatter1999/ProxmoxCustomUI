import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Guacamole from 'guacamole-common-js'
import { AuthError, fetchRdpToken } from '../api'

type Status = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function RdpSession({ node, vmid, name, onClose, onAuthError }: {
  node: string
  vmid: number
  name?: string
  onClose: () => void
  onAuthError: () => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const displayHostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === boxRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      boxRef.current?.requestFullscreen().catch(() => {
        setError('This browser blocked fullscreen - try again or use its own fullscreen shortcut.')
      })
    }
  }

  useEffect(() => {
    let stop = false
    let client: InstanceType<typeof Guacamole.Client> | null = null
    setStatus('connecting')
    setError('')

    async function connect() {
      try {
        // Server looks up the machine's stored login and current address
        // itself (elevated) and hands back an opaque, encrypted token - this
        // never touches the Windows password directly, and works the same
        // for a tech login as it does for root.
        const token = await fetchRdpToken(node, vmid)
        if (stop || !displayHostRef.current) return

        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        const tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/guac-ws?token=${encodeURIComponent(token)}`)
        client = new Guacamole.Client(tunnel)

        const display = client.getDisplay()
        const displayElement = display.getElement()
        displayHostRef.current.appendChild(displayElement)

        const fit = () => {
          const host = displayHostRef.current
          const w = display.getWidth()
          const h = display.getHeight()
          if (!host || !w || !h) return
          const scale = Math.min(host.clientWidth / w, host.clientHeight / h, 1)
          display.scale(scale > 0 ? scale : 1)
        }
        display.onresize = fit
        window.addEventListener('resize', fit)

        const mouse = new Guacamole.Mouse(displayElement)
        mouse.onEach(['mousedown', 'mousemove', 'mouseup'], e => {
          e.preventDefault()
          client?.sendMouseState(e.state, true)
        })

        // Scoped to the display itself (needs tabIndex to be focusable), not
        // the whole document - otherwise this would capture every keystroke
        // on the page, even after the modal closes.
        const keyboard = new Guacamole.Keyboard(displayElement)
        keyboard.onkeydown = keysym => client?.sendKeyEvent(1, keysym)
        keyboard.onkeyup = keysym => client?.sendKeyEvent(0, keysym)
        displayElement.tabIndex = 0
        displayElement.style.outline = 'none'

        client.onstatechange = state => {
          if (stop) return
          if (state === Guacamole.Client.State.CONNECTED) {
            setStatus('connected')
            fit()
            displayElement.focus()
          } else if (state === Guacamole.Client.State.DISCONNECTED) {
            setStatus('disconnected')
          }
        }
        client.onerror = st => {
          if (stop) return
          setStatus('error')
          setError(st.message ?? 'The RDP connection failed')
        }

        client.connect()
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
      client?.disconnect()
    }
  }, [node, vmid, onAuthError, attempt])

  const showOverlay = status !== 'connected'

  // Portalled to <body> for the same reason as Console: MachineCard has
  // class "card", whose backdrop-filter makes it the containing block for
  // any position:fixed descendant, which would pin this modal to that one
  // small card instead of the screen.
  return createPortal(
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal-console">
        <div className="modal-head">
          <h2>{name ?? `VM ${vmid}`} <span className="muted">- RDP</span></h2>
          <div className="console-head-actions">
            <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="console-screen" ref={boxRef}>
          <div className="console-canvas" ref={displayHostRef} />
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
