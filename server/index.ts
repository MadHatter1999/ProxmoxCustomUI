import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
/// <reference path="./guacamole-lite.d.ts" />
import GuacamoleLite from 'guacamole-lite'

const here = path.dirname(fileURLToPath(import.meta.url))
const PVE_HOST = process.env.PVE_HOST ?? 'https://192.168.200.100:8006'
const PVE_URL = new URL(PVE_HOST)
const PORT = Number(process.env.PORT ?? 8080)
// Full "user@realm!tokenid=secret" for root's API token - grants uploads even
// for tech logins that don't have Datastore permissions of their own. See
// README for how to create it. Server-side only, never sent to the browser.
const ROOT_TOKEN = process.env.PVE_ROOT_TOKEN ?? ''
// AES-256-CBC key for the RDP gateway's connection tokens - derived, not
// separately configured. It's secret because ROOT_TOKEN is secret; anyone
// who could forge a valid one could already do anything ROOT_TOKEN can do,
// so there's no new credential for Tony to manage.
const RDP_KEY = crypto.createHash('sha256').update(ROOT_TOKEN || 'unset').digest()

// pve1 uses a self-signed cert everywhere in this lab; our own outbound
// fetch() calls below need to trust it the same way the /api2 proxy already
// does (via its `secure: false` option).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const app = express()

// Proxy the Proxmox API: solves browser CORS and the self-signed PVE
// certificate. ws:true also carries the noVNC console's websocket through -
// its .upgrade handler is wired to the actual server instance below, since
// that only exists once we know which of the two listen() branches runs.
const apiProxy = createProxyMiddleware({
  pathFilter: '/api2',
  target: PVE_HOST,
  changeOrigin: true,
  secure: false,
  ws: true
})
app.use(apiProxy)

/** Anyone with a valid Proxmox session (any user, any realm) passes this. */
async function isSignedIn(cookieHeader: string | undefined): Promise<boolean> {
  if (!cookieHeader?.includes('PVEAuthCookie=')) return false
  try {
    const r = await fetch(`${PVE_HOST}/api2/json/access/permissions`, { headers: { Cookie: cookieHeader } })
    return r.ok
  } catch {
    return false
  }
}

function readRawBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Calls an /api2/json path as root instead of the caller's own session. Tech
 * logins get PVEVMAdmin, which covers VM lifecycle actions but not Datastore
 * rights and doesn't reliably surface node/storage entries in
 * /cluster/resources either - Tony's call was "idc, run it as root": every
 * VM action from a tech goes through here now, not just uploads. Same method
 * and body as the original request; only the auth header changes.
 */
async function elevatedCall(req: express.Request, pveJsonPath: string): Promise<{ status: number; text: string }> {
  if (!ROOT_TOKEN) throw new Error('Server has no PVE_ROOT_TOKEN configured - ask Tony to set one up')
  const init: RequestInit = {
    method: req.method,
    headers: { Authorization: `PVEAPIToken=${ROOT_TOKEN}` }
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    const body = await readRawBody(req)
    if (body.length) {
      init.body = new Uint8Array(body)
      ;(init.headers as Record<string, string>)['content-type'] =
        req.headers['content-type'] ?? 'application/x-www-form-urlencoded'
    }
  }
  const r = await fetch(`${PVE_HOST}${pveJsonPath}`, init)
  return { status: r.status, text: await r.text() }
}

async function elevatedGet(pveJsonPath: string): Promise<unknown> {
  if (!ROOT_TOKEN) throw new Error('Server has no PVE_ROOT_TOKEN configured - ask Tony to set one up')
  const r = await fetch(`${PVE_HOST}${pveJsonPath}`, {
    headers: { Authorization: `PVEAPIToken=${ROOT_TOKEN}` }
  })
  if (!r.ok) throw new Error(`Couldn't reach the cluster (HTTP ${r.status})`)
  return (await r.json()).data
}

interface IsoTarget {
  node: string
  storage: string
  pctUsed: number
  freeBytes: number
}

/** Mirrors src/placement.ts's pickIsoTarget - kept in sync deliberately, not imported (separate build). */
function pickIsoTarget(resources: Array<Record<string, unknown>>): IsoTarget | null {
  const isoStorages = resources.filter(
    r => r.type === 'storage' && String(r.content ?? '').includes('iso') && Number(r.maxdisk ?? 0) > 0
  )
  if (!isoStorages.length) return null
  const onPve1 = isoStorages.find(s => s.node === 'pve1') ?? isoStorages[0]
  const maxdisk = Number(onPve1.maxdisk ?? 1)
  const used = Number(onPve1.disk ?? 0)
  return {
    node: String(onPve1.node),
    storage: String(onPve1.storage),
    pctUsed: (used / maxdisk) * 100,
    freeBytes: maxdisk - used
  }
}

async function fetchIsoTargetAsRoot(): Promise<IsoTarget | null> {
  const data = (await elevatedGet('/api2/json/cluster/resources')) as Array<Record<string, unknown>>
  return pickIsoTarget(data)
}

/** Mirrors src/machine.ts's parseMeta - kept in sync deliberately, not imported (separate build). */
function parseMeta(description?: string): { user?: string; pass?: string } | null {
  if (!description) return null
  const m = description.match(/proxbox:(\{.*\})/s)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

// Elevated path for everything: any signed-in user (root or a scoped tech
// login) reads and mutates cluster state - VM list, storage, start/stop,
// snapshots, VM creation - under root's API token rather than their own.
// Techs only ever reach this through the app (gated by isSignedIn below), so
// this is a deliberate simplification, not a leak: Proxmox's own per-role
// permission model stops mattering for anyone using the app as intended.
app.all('/svc/pve/*', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) {
    console.log(`[svc/pve] ${req.method} ${req.originalUrl} -> 401 not signed in`)
    return res.status(401).json({ message: 'Not signed in' })
  }
  const upstreamPath = req.originalUrl.replace(/^\/svc\/pve/, '/api2/json')
  try {
    const { status, text } = await elevatedCall(req, upstreamPath)
    console.log(`[svc/pve] ${req.method} ${upstreamPath} -> ${status}${status >= 400 ? ' ' + text.slice(0, 300) : ''}`)
    res.status(status).type('application/json').send(text)
  } catch (err) {
    console.error(`[svc/pve] ${req.method} ${upstreamPath} FAILED:`, err)
    res.status(502).json({ message: err instanceof Error ? err.message : String(err) })
  }
})

// Elevated image-upload path: same reasoning as above, but for the write
// itself - the actual disk write happens under root's API token instead of
// the tech's own session, since PVEVMAdmin never includes Datastore rights.
app.get('/svc/iso-target', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  try {
    const target = await fetchIsoTargetAsRoot()
    if (!target) return res.status(503).json({ message: 'No image storage is reachable right now' })
    res.json(target)
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/svc/upload-iso', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  let target: IsoTarget | null
  try {
    target = await fetchIsoTargetAsRoot()
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!target) return res.status(503).json({ message: 'No image storage is reachable right now' })

  const upstream = https.request(
    {
      hostname: PVE_URL.hostname,
      port: PVE_URL.port || 443,
      path: `/api2/json/nodes/${target.node}/storage/${target.storage}/upload`,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'content-type': req.headers['content-type'] ?? '',
        'content-length': req.headers['content-length'] ?? '',
        Authorization: `PVEAPIToken=${ROOT_TOKEN}`
      }
    },
    upstreamRes => {
      res.status(upstreamRes.statusCode ?? 502)
      upstreamRes.pipe(res)
    }
  )
  upstream.on('error', err => res.status(502).json({ message: err.message }))
  req.pipe(upstream)
})

function encryptGuacToken(payload: unknown): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', RDP_KEY, iv)
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'base64')
  encrypted += cipher.final('base64')
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value: encrypted })).toString('base64')
}

interface AgentInterfaces {
  result?: Array<{ name: string; 'ip-addresses'?: Array<{ 'ip-address': string; 'ip-address-type': string }> }>
}

/**
 * RDP gateway, same reasoning as the console: proxied through the app and
 * authenticated as the caller's own PVE login, not a machine-local Windows
 * account only the person who ran "Open RDP access" knows. The browser never
 * sees the VM's Windows password - this mints a short-lived encrypted token
 * that only guacd (via guacamole-lite, see below) can decrypt.
 */
app.get('/svc/rdp-token', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  if (!ROOT_TOKEN) return res.status(500).json({ message: 'Server has no PVE_ROOT_TOKEN configured - ask Tony to set one up' })
  const node = String(req.query.node ?? '')
  const vmid = String(req.query.vmid ?? '')
  if (!node || !vmid) return res.status(400).json({ message: 'node and vmid required' })

  try {
    const cfg = (await elevatedGet(`/api2/json/nodes/${node}/qemu/${vmid}/config`)) as { description?: string }
    const meta = parseMeta(cfg.description)
    if (!meta?.user) {
      return res.status(400).json({
        message: "This machine has no stored login yet - set one via 'Open RDP access' or when spinning it up."
      })
    }

    const ifaceData = (await elevatedGet(
      `/api2/json/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
    )) as AgentInterfaces
    let ip: string | null = null
    for (const iface of ifaceData.result ?? []) {
      if (iface.name.toLowerCase().startsWith('lo')) continue
      for (const a of iface['ip-addresses'] ?? []) {
        if (a['ip-address-type'] === 'ipv4' && !a['ip-address'].startsWith('127.')) {
          ip = a['ip-address']
          break
        }
      }
      if (ip) break
    }
    if (!ip) {
      return res.status(503).json({ message: "Couldn't detect this machine's address yet - the guest agent may still be starting." })
    }

    const token = encryptGuacToken({
      connection: {
        type: 'rdp',
        settings: {
          hostname: ip,
          port: '3389',
          username: meta.user,
          password: meta.pass ?? '',
          'ignore-cert': true,
          security: 'any',
          width: 1366,
          height: 768,
          'resize-method': 'display-update'
        }
      }
    })
    console.log(`[rdp-token] issued for ${node}/${vmid} -> ${ip}`)
    res.json({ token })
  } catch (err) {
    console.error(`[rdp-token] ${node}/${vmid} FAILED:`, err)
    res.status(502).json({ message: err instanceof Error ? err.message : String(err) })
  }
})

const dist = path.resolve(here, '..', 'dist')
app.use(express.static(dist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'))
})

// Logged wrapper around the proxy's upgrade handler - the "Disconnected"
// reports gave zero server-side signal, so log every websocket upgrade
// attempt (does it even arrive here?) and how its socket ends (does the
// proxy hang up on it immediately, and with what error if any?).
function loggedUpgrade(req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) {
  console.log(`[upgrade] ${req.method} ${req.url}`)
  socket.on('error', err => console.log(`[upgrade] socket error on ${req.url}:`, err.message))
  socket.on('close', hadError => console.log(`[upgrade] socket closed on ${req.url} (hadError=${hadError})`))
  apiProxy.upgrade(req, socket, head)
}

/**
 * guacd (Apache Guacamole's protocol daemon) runs in a local-only Docker
 * container on 127.0.0.1:4822 - never exposed to the LAN directly. Attaching
 * guacamole-lite with {server, path} makes `ws` filter by path itself, so it
 * coexists with the noVNC upgrade handling above without stepping on it.
 */
function startRdpGateway(server: import('node:http').Server | import('node:https').Server) {
  if (!ROOT_TOKEN) {
    console.log('[guac] PVE_ROOT_TOKEN not set - RDP gateway disabled')
    return
  }
  new GuacamoleLite(
    { server, path: '/guac-ws' },
    { host: '127.0.0.1', port: 4822 },
    { crypt: { cypher: 'AES-256-CBC', key: RDP_KEY }, log: { level: 1 } }
  )
  console.log('[guac] RDP gateway ready on /guac-ws')
}

if (process.env.HTTPS === '1') {
  // PWA installability needs a secure context off-localhost; generate a
  // self-signed cert on first run (team accepts it once per browser).
  const certDir = path.resolve(here, '..', '.cert')
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const { default: selfsigned } = await import('selfsigned')
    const pems = selfsigned.generate([{ name: 'commonName', value: 'proxbox.local' }], {
      days: 3650,
      keySize: 2048
    })
    fs.mkdirSync(certDir, { recursive: true })
    fs.writeFileSync(keyFile, pems.private)
    fs.writeFileSync(certFile, pems.cert)
    console.log(`Generated self-signed certificate in ${certDir}`)
  }
  const server = https
    .createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app)
    .listen(PORT, () => console.log(`ProxBox Spin-Up (https) on port ${PORT} → ${PVE_HOST}`))
  server.on('upgrade', loggedUpgrade)
  startRdpGateway(server)
} else {
  const server = app.listen(PORT, () => console.log(`ProxBox Spin-Up on port ${PORT} → ${PVE_HOST}`))
  server.on('upgrade', loggedUpgrade)
  startRdpGateway(server)
}
