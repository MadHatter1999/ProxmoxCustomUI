import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { execFileSync } from 'node:child_process'
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

// guacamole-lite's websocket server runs on its own internal-only port
// rather than sharing this server's 'upgrade' event directly. Unlike
// http-proxy-middleware (which silently no-ops on a pathFilter mismatch),
// raw `ws` WebSocketServer attached via {server, path} actively rejects and
// destroys any upgrade request that doesn't match its own path *before*
// other listeners see it - that killed the noVNC console the moment this
// was added. Proxying to an isolated port sidesteps the conflict entirely,
// using the same pattern already proven correct for the /api2 proxy above.
const GUAC_PORT = 8082
const guacProxy = createProxyMiddleware({
  pathFilter: '/guac-ws',
  target: `http://127.0.0.1:${GUAC_PORT}`,
  changeOrigin: true,
  ws: true
})

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

// ---- GhostDrive WIM library ------------------------------------------------
// The 5TB image drive, mounted READ-ONLY on this box over CIFS. We walk it
// recursively and hand the app a FLAT list of every WIM, so staff pick an image
// by name instead of digging through its folder tree. We only ever read here.
const WIM_ROOT = process.env.WIM_ROOT ?? '/mnt/ghostdrive'
const WIM_TTL_MS = 60_000
// WIM uploads land here - a read-WRITE mount of the same 5TB drive (app-only
// Samba share). Written to an Uploads/ subfolder so the sacred library is never
// touched; the scan above (WIM_ROOT) then picks them up like any other image.
const WIM_UPLOAD_DIR = process.env.WIM_UPLOAD_DIR ?? '/mnt/ghostupload/Uploads'

interface WimEntry { name: string; path: string; folder: string; sizeBytes: number; sizeGb: number }
let wimCache: { at: number; data: WimEntry[] } | null = null

async function scanWims(root: string): Promise<WimEntry[]> {
  const out: WimEntry[] = []
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name.startsWith('.')) continue // skip $RECYCLE.BIN, System Volume Info, hidden
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (/\.(wim|esd|swm)$/i.test(e.name)) {
        try {
          const st = await fs.promises.stat(full)
          const rel = path.relative(root, full)
          const folder = path.dirname(rel)
          out.push({
            name: e.name.replace(/\.(wim|esd|swm)$/i, ''),
            path: rel,
            folder: folder === '.' ? '' : folder,
            sizeBytes: st.size,
            sizeGb: Math.round((st.size / 1073741824) * 100) / 100
          })
        } catch { /* unreadable file - skip it rather than fail the whole scan */ }
      }
    }
  }
  await walk(root)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

app.get('/svc/wims', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  if (!fs.existsSync(WIM_ROOT)) {
    return res.status(503).json({ message: `WIM drive not mounted at ${WIM_ROOT} - ask an admin.` })
  }
  try {
    if (wimCache && Date.now() - wimCache.at < WIM_TTL_MS) return res.json(wimCache.data)
    const data = await scanWims(WIM_ROOT)
    wimCache = { at: Date.now(), data }
    res.json(data)
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : String(err) })
  }
})

// ---- WIM deploy (WinPE) ----------------------------------------------------
// Picking a WIM in the UI spins up a VM that self-deploys it: it boots our
// WinPE ISO, which reads a tiny per-VM config ISO (built here), pulls the WIM
// off GhostDrive, DISM-applies it, bcdboots, and powers off. We watch for that
// power-off, then swap the VM to boot from disk and delete the throwaway config
// ISO so the drive doesn't fill up.
const WINPE_ISO = process.env.WINPE_ISO ?? 'local:iso/proxbox-winpe-deploy.iso'
const DEPLOY_NODE = process.env.DEPLOY_NODE ?? 'pve1'   // WinPE + config ISOs physically live on pve1's local
const DEPLOY_STORAGE = process.env.DEPLOY_STORAGE ?? 'local'
// Built from plain host + share name, NOT a full UNC in an env var - systemd's
// EnvironmentFile eats backslashes, which silently broke deploys. GhostDeploy is
// a read-only, subnet-wide share the deploy VMs pull WIMs from (separate from
// GhostDrive, which Tony repurposed for the RemoteFTP staging link).
const GHOST_HOST = process.env.GHOST_HOST ?? '192.168.200.100'
const GHOST_SHARE_NAME = process.env.GHOST_SHARE_NAME ?? 'GhostDeploy'
const GHOST_SHARE = `\\\\${GHOST_HOST}\\${GHOST_SHARE_NAME}`
const GHOST_USER = process.env.GHOST_USER ?? 'Ghost'
const GHOST_PASS = process.env.GHOST_PASS ?? 'AtlasInTheEnd26!!'

/** A write to the PVE API under root's token, not tied to an incoming request. */
async function elevatedRequest(method: string, pvePath: string, params?: Record<string, string | number>): Promise<unknown> {
  if (!ROOT_TOKEN) throw new Error('Server has no PVE_ROOT_TOKEN configured')
  const init: RequestInit = { method, headers: { Authorization: `PVEAPIToken=${ROOT_TOKEN}` } }
  if (params && method !== 'GET') {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) body.append(k, String(v))
    init.body = body
    ;(init.headers as Record<string, string>)['content-type'] = 'application/x-www-form-urlencoded'
  }
  const r = await fetch(`${PVE_HOST}${pvePath}`, init)
  const text = await r.text()
  if (!r.ok) throw new Error(`PVE ${method} ${pvePath} -> ${r.status}: ${text.slice(0, 300)}`)
  try { return JSON.parse(text).data } catch { return text }
}

/** Build a tiny ISO holding proxbox-deploy.conf and upload it to PVE ISO storage. */
async function buildAndUploadConfigIso(vmid: number, wimRelPath: string, wimIndex: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join('/tmp', 'pbcfg-'))
  try {
    const winPath = wimRelPath.replace(/\//g, '\\')
    // LF-only so WinPE's `for /f` doesn't inherit a trailing CR on each value.
    const conf =
      `SHARE=${GHOST_SHARE}\nSHAREUSER=${GHOST_USER}\nSHAREPASS=${GHOST_PASS}\n` +
      `WIMPATH=${winPath}\nWIMINDEX=${wimIndex}\n`
    fs.writeFileSync(path.join(dir, 'proxbox-deploy.conf'), conf, 'latin1')
    const isoPath = path.join(dir, 'cfg.iso')
    execFileSync('genisoimage', ['-J', '-R', '-V', 'PROXBOXCFG', '-o', isoPath, dir], { stdio: 'ignore' })
    const filename = `proxbox-cfg-${vmid}.iso`
    const boundary = '----proxbox' + crypto.randomBytes(8).toString('hex')
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\niso\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    )
    const body = Buffer.concat([pre, fs.readFileSync(isoPath), Buffer.from(`\r\n--${boundary}--\r\n`)])
    const r = await fetch(`${PVE_HOST}/api2/json/nodes/${DEPLOY_NODE}/storage/${DEPLOY_STORAGE}/upload`, {
      method: 'POST',
      headers: { Authorization: `PVEAPIToken=${ROOT_TOKEN}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    })
    if (!r.ok) throw new Error('config ISO upload failed: ' + (await r.text()).slice(0, 300))
    return `${DEPLOY_STORAGE}:iso/${filename}`
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Tap Enter for a while to clear WinPE's "Press any key to boot from CD" prompt. */
async function clearBootPrompt(node: string, vmid: number): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    try { await elevatedRequest('PUT', `/api2/json/nodes/${node}/qemu/${vmid}/sendkey`, { key: 'ret' }) } catch { /* keep tapping */ }
  }
}

/** When WinPE finishes and powers the VM off, swap it to boot from disk and bin the config ISO. */
async function finalizeWhenDeployed(node: string, vmid: number, cfgVolid: string): Promise<void> {
  let sawRunning = false
  for (let i = 0; i < 240; i++) { // up to ~80 min
    await sleep(20000)
    let status = ''
    try {
      const st = (await elevatedGet(`/api2/json/nodes/${node}/qemu/${vmid}/status/current`)) as { status?: string }
      status = st.status ?? ''
    } catch { continue }
    if (status === 'running') sawRunning = true
    if (sawRunning && status === 'stopped') {
      try {
        await elevatedRequest('PUT', `/api2/json/nodes/${node}/qemu/${vmid}/config`, { delete: 'ide2,ide3' })
        await elevatedRequest('PUT', `/api2/json/nodes/${node}/qemu/${vmid}/config`, { boot: 'order=ide0' })
        await elevatedRequest('DELETE', `/api2/json/nodes/${node}/storage/${DEPLOY_STORAGE}/content/${encodeURIComponent(cfgVolid)}`).catch(() => {})
        await elevatedRequest('POST', `/api2/json/nodes/${node}/qemu/${vmid}/status/start`)
      } catch (err) {
        console.error('[deploy-wim] finalize failed:', err)
      }
      return
    }
  }
  console.error(`[deploy-wim] VM ${vmid} never powered off - config ISO ${cfgVolid} left in place for inspection`)
}

/**
 * Pick the best node to spin a deploy VM up on RIGHT NOW: the online node with
 * the most free RAM that also has an images storage the disk fits on (under 90%).
 * The WinPE + config ISOs are NFS-shared from the ISO host, and the WIM share is
 * reachable over the network, so a deploy can run on ANY node - no reason to pile
 * everything on pve1. Returns the node and the storage to build the disk on.
 */
async function pickDeployNode(memMb: number, diskGb: number, cores: number): Promise<{ node: string; storage: string }> {
  const data = (await elevatedGet('/api2/json/cluster/resources')) as Array<Record<string, unknown>>
  const GB = 1024 ** 3
  const needMem = memMb * 1024 * 1024
  const needDisk = diskGb * GB
  const HEADROOM = 2 * GB          // never squeeze a host to its last byte of RAM
  const CAP = 0.9                  // a new disk must not push a storage past 90%
  const nodes = data.filter(r => r.type === 'node' && r.status === 'online')
  const storages = data.filter(r => r.type === 'storage' && String(r.content ?? '').includes('images') && Number(r.maxdisk ?? 0) > 0)
  const fits = (s: Record<string, unknown>) => (Number(s.disk ?? 0) + needDisk) / Number(s.maxdisk ?? 1) <= CAP
  const cands: Array<{ node: string; storage: string; freeMem: number }> = []
  for (const n of nodes) {
    const node = String(n.node)
    if (Number(n.maxcpu ?? 0) < cores) continue
    const freeMem = Number(n.maxmem ?? 0) - Number(n.mem ?? 0) - HEADROOM
    if (freeMem < needMem) continue
    const onNode = storages.filter(s => s.node === node && fits(s))
    if (!onNode.length) continue
    // Prefer plain 'local' (dir → raw disk, simplest for WinPE); else any that fits.
    const pick = onNode.find(s => s.storage === 'local') ?? onNode[0]
    cands.push({ node, storage: String(pick.storage), freeMem })
  }
  cands.sort((a, b) => b.freeMem - a.freeMem)
  if (!cands.length) throw new Error('No node has room for this machine right now - try a smaller disk, or free something up.')
  return { node: cands[0].node, storage: cands[0].storage }
}

app.post('/svc/deploy-wim', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  if (!ROOT_TOKEN) return res.status(500).json({ message: 'Server has no PVE_ROOT_TOKEN configured' })
  const p = new URLSearchParams((await readRawBody(req)).toString())
  const name = p.get('name') ?? ''
  const wim = p.get('wim') ?? ''
  const wimIndex = Number(p.get('index') ?? '1') || 1
  const cores = Number(p.get('cores') ?? '4') || 4
  const memory = Number(p.get('memory') ?? '8192') || 8192
  const disk = Number(p.get('disk') ?? '120') || 120
  const description = p.get('description') ?? 'Created with ProxBox'
  if (!name || !wim) return res.status(400).json({ message: 'name and wim are required' })

  try {
    const vmid = Number(await elevatedGet('/api2/json/cluster/nextid'))
    // Config ISO is uploaded to the ISO host (pve1); local:iso is NFS-shared to
    // every node, so it - and the WinPE ISO - resolve on whatever node we land on.
    const cfgVolid = await buildAndUploadConfigIso(vmid, wim, wimIndex)
    const { node, storage } = await pickDeployNode(memory, disk, cores)
    console.log(`[deploy-wim] ${name} (vmid ${vmid}) -> node ${node}, storage ${storage}`)
    await elevatedRequest('POST', `/api2/json/nodes/${node}/qemu`, {
      vmid, name, machine: 'q35', bios: 'ovmf', cores, sockets: 1, memory, ostype: 'win11',
      cpu: 'x86-64-v2-AES', scsihw: 'virtio-scsi-single', net0: 'e1000,bridge=vmbr0,firewall=1',
      efidisk0: `${storage}:1,efitype=4m,pre-enrolled-keys=1`,
      tpmstate0: `${storage}:1,version=v2.0`,
      ide0: `${storage}:${disk}`,
      ide2: `${WINPE_ISO},media=cdrom`,
      ide3: `${cfgVolid},media=cdrom`,
      boot: 'order=ide2;ide0',
      description
    })
    await elevatedRequest('POST', `/api2/json/nodes/${node}/qemu/${vmid}/status/start`)
    // Fire-and-forget: clear the boot prompt, then finalize once WinPE powers off.
    clearBootPrompt(node, vmid).catch(() => {})
    finalizeWhenDeployed(node, vmid, cfgVolid).catch(err => console.error('[deploy-wim]', err))
    res.json({ vmid, node })
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : String(err) })
  }
})

// Upload a WIM (or .esd/.swm) straight onto the 5TB drive's Uploads/ folder.
// Streamed to a .part file and renamed on completion, so the scan never lists a
// half-uploaded image. Any signed-in user can do this (root-token-backed mount).
app.post('/svc/upload-wim', async (req, res) => {
  if (!(await isSignedIn(req.headers.cookie))) return res.status(401).json({ message: 'Not signed in' })
  const raw = String(req.query.filename ?? '')
  const safe = path.basename(raw).replace(/[^A-Za-z0-9._ ()\-]/g, '_')
  if (!/\.(wim|esd|swm)$/i.test(safe)) {
    return res.status(400).json({ message: 'Only .wim, .esd or .swm files can be uploaded here.' })
  }
  try { fs.mkdirSync(WIM_UPLOAD_DIR, { recursive: true }) } catch { /* exists / created by admin */ }
  const dest = path.join(WIM_UPLOAD_DIR, safe)
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let failed = false
  const fail = (code: number, msg: string) => {
    if (failed) return
    failed = true
    out.destroy()
    try { fs.rmSync(tmp, { force: true }) } catch { /* already gone */ }
    if (!res.headersSent) res.status(code).json({ message: msg })
  }
  req.on('error', () => fail(400, 'Upload connection dropped'))
  out.on('error', err => fail(500, 'Write to the drive failed: ' + err.message))
  out.on('finish', () => {
    if (failed) return
    try {
      fs.renameSync(tmp, dest)
      wimCache = null // so the new image shows up on the next scan immediately
      res.json({ ok: true, path: `Uploads/${safe}` })
    } catch (err) {
      fail(500, 'Couldn\'t finalize the upload: ' + (err instanceof Error ? err.message : String(err)))
    }
  })
  req.pipe(out)
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
  // Both are http-proxy-middleware instances, each gated by its own
  // pathFilter - safe to call unconditionally, unlike raw `ws` servers.
  apiProxy.upgrade(req, socket, head)
  guacProxy.upgrade(req, socket, head)
}

/**
 * guacd (Apache Guacamole's protocol daemon) runs in a local-only Docker
 * container on 127.0.0.1:4822. guacamole-lite gets its own internal-only
 * websocket server (127.0.0.1 only, not 0.0.0.0) rather than sharing the
 * main server's 'upgrade' event - see the comment on guacProxy above for why.
 * The main server proxies /guac-ws to it just like /api2 proxies to pve1.
 */
function startRdpGateway() {
  if (!ROOT_TOKEN) {
    console.log('[guac] PVE_ROOT_TOKEN not set - RDP gateway disabled')
    return
  }
  new GuacamoleLite(
    { port: GUAC_PORT, host: '127.0.0.1' },
    { host: '127.0.0.1', port: 4822 },
    { crypt: { cypher: 'AES-256-CBC', key: RDP_KEY }, log: { level: 1 } }
  )
  console.log(`[guac] RDP gateway ready on 127.0.0.1:${GUAC_PORT} (proxied via /guac-ws)`)
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
  startRdpGateway()
} else {
  const server = app.listen(PORT, () => console.log(`ProxBox Spin-Up on port ${PORT} → ${PVE_HOST}`))
  server.on('upgrade', loggedUpgrade)
  startRdpGateway()
}
