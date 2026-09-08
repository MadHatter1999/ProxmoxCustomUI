import crypto from 'node:crypto'
import express from 'express'
import { androidConfig } from './config.js'
import { ANDROID_VERSIONS } from './compat.js'
import { recordHeartbeat, type HeartbeatBody } from './nodes.js'
import {
  deleteHardwareProfile,
  deleteImage,
  formFactors,
  hardwareProfiles,
  images,
  networkProfiles,
  saveHardwareProfile,
  saveImage
} from './registry.js'
import { explain, planDevice } from './scheduler.js'
import { store } from './store.js'
import { runtimes } from './runtime/index.js'
import type { AndroidImage, DeviceRecord, DeviceRequest, HardwareProfile, Orientation } from './types.js'

/**
 * The Android subsystem's HTTP surface, mounted under /svc/android.
 *
 * It follows the conventions already in server/index.ts rather than inventing
 * new ones: every browser-facing route is gated by the same isSignedIn check,
 * bodies are read raw (this router must never install a global body parser -
 * that would break the streamed ISO and WIM uploads), and errors come back as
 * { message } in a sentence a person can act on.
 *
 * Two things are deliberately NOT here:
 *  - No websocket. The existing upgrade path carries noVNC and Guacamole and
 *    has already been broken once by a second ws server; the screen stream is
 *    HTTP polling until it can be added the same way guacamole-lite was (own
 *    port, proxied). See docs/android/remote-control.md.
 *  - No raw ADB. Everything goes controller -> node agent -> adb, always.
 */

export interface AndroidRouterDeps {
  /** The same signed-in check the rest of the app uses. */
  isSignedIn: (cookieHeader: string | undefined) => Promise<boolean>
}

const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

function readRaw(req: express.Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`That is larger than the ${Math.round(limit / 1024 / 1024)} MB limit for this endpoint.`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson<T>(req: express.Request): Promise<T> {
  const raw = await readRaw(req, MAX_JSON_BYTES)
  if (!raw.length) return {} as T
  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    throw new Error('That request body was not valid JSON.')
  }
}

/**
 * Who is calling. isSignedIn has already proved the ticket is real with PVE;
 * this only reads the username out of it for the audit log and reservations,
 * so a forged name would be a forged ticket, which PVE already rejected.
 */
function callerName(req: express.Request): string {
  const cookie = req.headers.cookie ?? ''
  const m = cookie.match(/PVEAuthCookie=([^;]+)/)
  if (!m) return 'unknown'
  try {
    const ticket = decodeURIComponent(m[1])
    const parts = ticket.split(':')
    return parts[1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

function fail(res: express.Response, status: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  res.status(status).json({ message })
}

/** Agent requests are signed, not cookie-authenticated - they have no browser. */
function agentAuthorised(req: express.Request, body: Buffer): boolean {
  if (!androidConfig.agentToken) return false
  const ts = String(req.headers['x-proxbox-ts'] ?? '')
  const sig = String(req.headers['x-proxbox-sig'] ?? '')
  if (!ts || !sig) return false
  // Five minutes of clock skew, then it is a replay.
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex')
  const expected = crypto
    .createHmac('sha256', androidConfig.agentToken)
    .update(`${ts}\n${req.method}\n${req.path}\n${bodyHash}`)
    .digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function createAndroidRouter(deps: AndroidRouterDeps): express.Router {
  const router = express.Router()

  // ---- agent intake (signed, no session) ----------------------------------

  router.post('/svc/android/agent/heartbeat', async (req, res) => {
    let raw: Buffer
    try {
      raw = await readRaw(req, MAX_JSON_BYTES)
    } catch (err) {
      return fail(res, 413, err)
    }
    if (!agentAuthorised(req, raw)) {
      return res.status(401).json({ message: 'Bad or missing agent signature.' })
    }
    try {
      const body = JSON.parse(raw.toString('utf8')) as HeartbeatBody
      if (!body.node) return res.status(400).json({ message: 'A heartbeat must say which node it is from.' })
      const caps = recordHeartbeat(body)
      runtimes.ensureWatcher()
      res.json({ ok: true, node: caps.node, devices: caps.physical.length })
    } catch (err) {
      fail(res, 400, err)
    }
  })

  // ---- everything below needs a ProxBox session ---------------------------

  router.use('/svc/android', async (req, res, next) => {
    if (req.path.startsWith('/agent/')) return next()
    if (!(await deps.isSignedIn(req.headers.cookie))) {
      return res.status(401).json({ message: 'Not signed in' })
    }
    next()
  })

  // ---- catalogue ----------------------------------------------------------

  router.get('/svc/android/catalog', (_req, res) => {
    res.json({
      images: images(),
      hardwareProfiles: hardwareProfiles(),
      formFactors: formFactors(),
      networks: networkProfiles(),
      runtimes: runtimes.kinds(),
      androidVersions: ANDROID_VERSIONS,
      mock: androidConfig.mock
    })
  })

  router.get('/svc/android/nodes', (_req, res) => {
    res.json(store.listNodes())
  })

  router.get('/svc/android/audit', (req, res) => {
    const limit = Math.min(1000, Number(req.query.limit ?? 200) || 200)
    res.json(store.readAudit(limit, req.query.device ? String(req.query.device) : undefined))
  })

  // ---- registries ---------------------------------------------------------

  router.post('/svc/android/profiles', async (req, res) => {
    try {
      const profile = await readJson<HardwareProfile>(req)
      if (!profile.id || !profile.name || !profile.formFactor) {
        throw new Error('A hardware profile needs at least an id, a name and a form factor.')
      }
      const saved = saveHardwareProfile(profile)
      store.audit({ at: Date.now(), user: callerName(req), action: 'profile.save', detail: saved.id, ok: true })
      res.json(saved)
    } catch (err) {
      fail(res, 400, err)
    }
  })

  router.delete('/svc/android/profiles/:id', (req, res) => {
    const gone = deleteHardwareProfile(req.params.id)
    if (!gone) return res.status(404).json({ message: 'That is not a profile this lab added.' })
    store.audit({ at: Date.now(), user: callerName(req), action: 'profile.delete', detail: req.params.id, ok: true })
    res.json({ ok: true })
  })

  router.post('/svc/android/images', async (req, res) => {
    try {
      const img = await readJson<AndroidImage>(req)
      if (!img.id || !img.name || !img.engines?.length) {
        throw new Error('An image needs an id, a name and at least one engine that can run it.')
      }
      const saved = saveImage(img)
      store.audit({ at: Date.now(), user: callerName(req), action: 'image.import', detail: saved.id, ok: true })
      res.json(saved)
    } catch (err) {
      fail(res, 400, err)
    }
  })

  router.delete('/svc/android/images/:id', (req, res) => {
    const gone = deleteImage(req.params.id)
    if (!gone) return res.status(404).json({ message: 'That is not an image this lab imported.' })
    store.audit({ at: Date.now(), user: callerName(req), action: 'image.delete', detail: req.params.id, ok: true })
    res.json({ ok: true })
  })

  // ---- planning -----------------------------------------------------------

  router.post('/svc/android/plan', async (req, res) => {
    try {
      const request = await readJson<DeviceRequest>(req)
      const user = callerName(req)
      const [plan, card] = await Promise.all([planDevice(request, { user }), explain(request, { user })])
      res.json({ plan, compatibility: card })
    } catch (err) {
      fail(res, 400, err)
    }
  })

  // ---- devices ------------------------------------------------------------

  router.get('/svc/android/devices', (_req, res) => {
    res.json(store.listDevices())
  })

  router.get('/svc/android/devices/:id', (req, res) => {
    const device = store.getDevice(req.params.id)
    if (!device) return res.status(404).json({ message: 'No such device.' })
    res.json(device)
  })

  router.post('/svc/android/devices', async (req, res) => {
    const user = callerName(req)
    try {
      const request = await readJson<DeviceRequest>(req)
      const plan = await planDevice(request, { user })
      if (!plan.ok) {
        return res.status(409).json({ message: plan.reason, detail: plan.detail, suggestion: plan.suggestion })
      }
      if (request.dryRun) return res.json({ plan })
      const device = await runtimes.create(plan, user)
      res.json(device)
    } catch (err) {
      fail(res, 502, err)
    }
  })

  /** start / stop / reboot / reset, all the same shape. */
  for (const action of ['start', 'stop', 'reboot', 'reset'] as const) {
    router.post(`/svc/android/devices/:id/${action}`, async (req, res) => {
      const user = callerName(req)
      const device = store.getDevice(req.params.id)
      if (!device) return res.status(404).json({ message: 'No such device.' })
      try {
        await runtimes.for(device)[action](device)
        store.audit({ at: Date.now(), user, action: `device.${action}`, deviceId: device.id, ok: true })
        res.json(store.getDevice(device.id) ?? device)
      } catch (err) {
        store.audit({
          at: Date.now(), user, action: `device.${action}`, deviceId: device.id,
          detail: err instanceof Error ? err.message : String(err), ok: false
        })
        fail(res, 502, err)
      }
    })
  }

  router.delete('/svc/android/devices/:id', async (req, res) => {
    const device = store.getDevice(req.params.id)
    if (!device) return res.status(404).json({ message: 'No such device.' })
    try {
      await runtimes.destroy(device, callerName(req))
      res.json({ ok: true })
    } catch (err) {
      fail(res, 502, err)
    }
  })

  // ---- reservations -------------------------------------------------------

  router.post('/svc/android/devices/:id/reserve', async (req, res) => {
    const user = callerName(req)
    const device = store.getDevice(req.params.id)
    if (!device) return res.status(404).json({ message: 'No such device.' })
    if (device.reservation && device.reservation.owner !== user) {
      return res.status(409).json({ message: `${device.name} is already in use by ${device.reservation.owner}.` })
    }
    const body = await readJson<{ minutes?: number; note?: string }>(req).catch(() => ({}) as { minutes?: number; note?: string })
    const minutes = Math.min(24 * 60, Math.max(5, Number(body.minutes ?? 0) || 0))
    const updated = store.patchDevice(device.id, {
      reservation: {
        owner: user,
        since: Date.now(),
        expiresAt: minutes ? Date.now() + minutes * 60_000 : undefined,
        note: body.note
      }
    })
    store.audit({ at: Date.now(), user, action: 'device.reserve', deviceId: device.id, ok: true })
    res.json(updated)
  })

  router.post('/svc/android/devices/:id/release', async (req, res) => {
    const user = callerName(req)
    const device = store.getDevice(req.params.id)
    if (!device) return res.status(404).json({ message: 'No such device.' })
    const updated = store.patchDevice(device.id, { reservation: null })
    store.audit({ at: Date.now(), user, action: 'device.release', deviceId: device.id, ok: true })
    // Reset-on-release is exactly what it says: hand it back clean.
    if (device.persistence === 'reset-on-release') {
      runtimes
        .for(device)
        .reset(device)
        .catch(err => console.error('[android] reset-on-release failed:', err))
    }
    res.json(updated)
  })

  // ---- control ------------------------------------------------------------

  /** Only the holder (or nobody holding it) may drive a device. */
  function mayControl(device: DeviceRecord, user: string): string | null {
    if (!device.reservation) return null
    if (device.reservation.owner === user) return null
    return `${device.name} is in use by ${device.reservation.owner}. Ask them to release it, or wait for the hold to expire.`
  }

  function withDevice(
    handler: (device: DeviceRecord, user: string, req: express.Request, res: express.Response) => Promise<void>
  ): express.RequestHandler {
    return async (req, res) => {
      const user = callerName(req)
      const device = store.getDevice(req.params.id)
      if (!device) {
        res.status(404).json({ message: 'No such device.' })
        return
      }
      const blocked = mayControl(device, user)
      if (blocked) {
        res.status(409).json({ message: blocked })
        return
      }
      try {
        await handler(device, user, req, res)
      } catch (err) {
        fail(res, 502, err)
      }
    }
  }

  router.post('/svc/android/devices/:id/shell', withDevice(async (device, user, req, res) => {
    const { command } = await readJson<{ command: string }>(req)
    if (!command?.trim()) throw new Error('No command was given.')
    const out = await runtimes.for(device).shell(device, command)
    // Command logging is deliberate: an ADB shell is the most powerful thing
    // this subsystem hands out, so every one of them is on the record.
    store.audit({ at: Date.now(), user, action: 'device.shell', deviceId: device.id, detail: command.slice(0, 500), ok: true })
    res.json({ output: out })
  }))

  router.get('/svc/android/devices/:id/screen', withDevice(async (device, _user, _req, res) => {
    const shot = await runtimes.for(device).screenshot(device)
    res.setHeader('content-type', shot.mime)
    res.setHeader('cache-control', 'no-store')
    res.send(shot.data)
  }))

  router.post('/svc/android/devices/:id/input', withDevice(async (device, _user, req, res) => {
    const body = await readJson<{
      type: 'tap' | 'swipe' | 'key' | 'text'
      x?: number; y?: number; x2?: number; y2?: number; ms?: number
      keycode?: string; value?: string
    }>(req)
    const adapter = runtimes.for(device)
    switch (body.type) {
      case 'tap':
        await adapter.tap(device, body.x ?? 0, body.y ?? 0)
        break
      case 'swipe':
        await adapter.swipe(device, body.x ?? 0, body.y ?? 0, body.x2 ?? 0, body.y2 ?? 0, body.ms ?? 200)
        break
      case 'key':
        await adapter.key(device, body.keycode ?? 'KEYCODE_HOME')
        break
      case 'text':
        await adapter.text(device, body.value ?? '')
        break
      default:
        throw new Error(`"${String(body.type)}" is not an input type.`)
    }
    res.json({ ok: true })
  }))

  router.post('/svc/android/devices/:id/display', withDevice(async (device, user, req, res) => {
    const body = await readJson<{ width?: number; height?: number; dpi?: number; orientation?: Orientation }>(req)
    const adapter = runtimes.for(device)
    if (body.width || body.height || body.dpi) await adapter.setDisplay(device, body)
    if (body.orientation) await adapter.setOrientation(device, body.orientation)
    const updated = store.patchDevice(device.id, {
      display: {
        ...device.display,
        ...(body.width ? { width: body.width } : {}),
        ...(body.height ? { height: body.height } : {}),
        ...(body.dpi ? { dpi: body.dpi } : {}),
        ...(body.orientation ? { orientation: body.orientation } : {})
      }
    })
    store.audit({ at: Date.now(), user, action: 'device.display', deviceId: device.id, detail: JSON.stringify(body), ok: true })
    res.json(updated)
  }))

  router.post('/svc/android/devices/:id/sensors', withDevice(async (device, _user, req, res) => {
    const body = await readJson<{
      gps?: { lat: number; lon: number; altitude?: number }
      battery?: { pct: number; charging: boolean }
      fold?: boolean
    }>(req)
    const adapter = runtimes.for(device)
    if (body.gps) await adapter.setGps(device, body.gps.lat, body.gps.lon, body.gps.altitude)
    if (body.battery) await adapter.setBattery(device, body.battery.pct, body.battery.charging)
    if (body.fold !== undefined) await adapter.setFold(device, body.fold)
    res.json({ ok: true })
  }))

  router.get('/svc/android/devices/:id/properties', withDevice(async (device, _user, _req, res) => {
    res.json(await runtimes.for(device).properties(device))
  }))

  router.post('/svc/android/devices/:id/install', withDevice(async (device, user, req, res) => {
    const name = String(req.query.name ?? 'app.apk')
    if (!/\.apk$/i.test(name)) throw new Error('Only .apk files can be installed this way.')
    const data = await readRaw(req, MAX_UPLOAD_BYTES)
    if (!data.length) throw new Error('No APK arrived.')
    const out = await runtimes.for(device).installApk(device, { name, data })
    store.audit({ at: Date.now(), user, action: 'device.install', deviceId: device.id, detail: `${name} (${data.length} bytes)`, ok: true })
    res.json({ output: out })
  }))

  router.post('/svc/android/devices/:id/uninstall', withDevice(async (device, user, req, res) => {
    const { packageName } = await readJson<{ packageName: string }>(req)
    const out = await runtimes.for(device).uninstall(device, packageName)
    store.audit({ at: Date.now(), user, action: 'device.uninstall', deviceId: device.id, detail: packageName, ok: true })
    res.json({ output: out })
  }))

  router.post('/svc/android/devices/:id/record/start', withDevice(async (device, _user, _req, res) => {
    res.json({ path: await runtimes.for(device).startRecording(device) })
  }))

  router.post('/svc/android/devices/:id/record/stop', withDevice(async (device, _user, _req, res) => {
    const data = await runtimes.for(device).stopRecording(device)
    res.setHeader('content-type', 'video/mp4')
    res.setHeader('content-disposition', `attachment; filename="${device.name}.mp4"`)
    res.send(data)
  }))

  return router
}
