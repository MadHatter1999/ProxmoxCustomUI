import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PVE_HOST = process.env.PVE_HOST ?? 'https://192.168.200.100:8006'
const PVE_URL = new URL(PVE_HOST)
const PORT = Number(process.env.PORT ?? 8080)
// Full "user@realm!tokenid=secret" for root's API token - grants uploads even
// for tech logins that don't have Datastore permissions of their own. See
// README for how to create it. Server-side only, never sent to the browser.
const ROOT_TOKEN = process.env.PVE_ROOT_TOKEN ?? ''

// pve1 uses a self-signed cert everywhere in this lab; our own outbound
// fetch() calls below need to trust it the same way the /api2 proxy already
// does (via its `secure: false` option).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const app = express()

// Proxy the Proxmox API: solves browser CORS and the self-signed PVE certificate.
app.use(
  createProxyMiddleware({
    pathFilter: '/api2',
    target: PVE_HOST,
    changeOrigin: true,
    secure: false
  })
)

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

// Elevated path for everything: any signed-in user (root or a scoped tech
// login) reads and mutates cluster state - VM list, storage, start/stop,
// snapshots, VM creation - under root's API token rather than their own.
// Techs only ever reach this through the app (gated by isSignedIn below), so
// this is a deliberate simplification, not a leak: Proxmox's own per-role
// permission model stops mattering for anyone using the app as intended.
app.all('/svc/pve/*', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  const upstreamPath = req.originalUrl.replace(/^\/svc\/pve/, '/api2/json')
  try {
    const { status, text } = await elevatedCall(req, upstreamPath)
    res.status(status).type('application/json').send(text)
  } catch (err) {
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

const dist = path.resolve(here, '..', 'dist')
app.use(express.static(dist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'))
})

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
  https
    .createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app)
    .listen(PORT, () => console.log(`ProxBox Spin-Up (https) on port ${PORT} → ${PVE_HOST}`))
} else {
  app.listen(PORT, () => console.log(`ProxBox Spin-Up on port ${PORT} → ${PVE_HOST}`))
}
