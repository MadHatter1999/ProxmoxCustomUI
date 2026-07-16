declare module 'guacamole-common-js' {
  class Tunnel {
    onerror: ((status: unknown) => void) | null
    onstatechange: ((state: number) => void) | null
  }

  class WebSocketTunnel extends Tunnel {
    constructor(url: string)
  }

  class Display {
    getElement(): HTMLElement
    getWidth(): number
    getHeight(): number
    scale(scale: number): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onresize: ((width: number, height: number) => void) | null
  }

  interface MouseState {
    x: number
    y: number
    left: boolean
    middle: boolean
    right: boolean
    up: boolean
    down: boolean
  }

  interface MouseEvent_ {
    state: MouseState
    preventDefault(): void
  }

  class Mouse {
    constructor(element: HTMLElement)
    onEach(events: string[], handler: (e: MouseEvent_) => void): void
  }

  class Keyboard {
    constructor(element: HTMLElement | Document)
    onkeydown: ((keysym: number) => void) | null
    onkeyup: ((keysym: number) => void) | null
  }

  class Client {
    constructor(tunnel: Tunnel)
    connect(data?: string): void
    disconnect(): void
    getDisplay(): Display
    sendKeyEvent(pressed: 0 | 1, keysym: number): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMouseState(state: MouseState, applyDisplayScale?: boolean): void
    onstatechange: ((state: number) => void) | null
    onerror: ((status: { message?: string }) => void) | null
    static State: {
      IDLE: 0
      CONNECTING: 1
      WAITING: 2
      CONNECTED: 3
      DISCONNECTING: 4
      DISCONNECTED: 5
    }
  }

  const Guacamole: {
    WebSocketTunnel: typeof WebSocketTunnel
    Client: typeof Client
    Mouse: typeof Mouse
    Keyboard: typeof Keyboard
  }

  export default Guacamole
}
