declare module '@novnc/novnc' {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: {
        credentials?: { username?: string; password?: string; target?: string }
        wsProtocols?: string[]
        shared?: boolean
      }
    )
    scaleViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addEventListener(type: string, listener: (ev: any) => void): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeEventListener(type: string, listener: (ev: any) => void): void
    disconnect(): void
  }
}
