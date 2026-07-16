declare module 'guacamole-lite' {
  interface WsOptions {
    server: import('node:http').Server | import('node:https').Server
    path?: string
  }
  interface GuacdOptions {
    host?: string
    port?: number
  }
  interface ClientOptions {
    crypt?: { cypher?: string; key?: Buffer | string }
    log?: { level?: number }
    [key: string]: unknown
  }
  export default class GuacamoleLite {
    constructor(wsOptions: WsOptions, guacdOptions?: GuacdOptions, clientOptions?: ClientOptions)
  }
}
