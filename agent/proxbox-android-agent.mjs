#!/usr/bin/env node
/**
 * ProxBox Android node agent.
 *
 * Runs on a Proxmox node. Two jobs, and only two:
 *
 *   1. Tell the controller what this node can do and what Android hardware is
 *      plugged into it (heartbeat, every 15s).
 *   2. Do exactly what the controller asks, over a signed local API: run an adb
 *      command, start or stop an emulator, resolve a MAC to an address.
 *
 * It is deliberately dependency-free - Node's standard library only - so
 * installing it is "copy one file and enable a unit", not "manage an npm tree
 * on a hypervisor".
 *
 * ADB never leaves this process. Nothing on the LAN can reach adb through it:
 * every request must carry an HMAC over (timestamp, method, path, body hash)
 * using the shared token, and every adb invocation is an argv array, never a
 * shell string.
 *
 *   ANDROID_AGENT_TOKEN   required, must match the controller's
 *   PROXBOX_CONTROLLER    e.g. http://proxbox.lab.local:8080
 *   ANDROID_AGENT_PORT    default 9599
 *   ANDROID_NODE_NAME     default `hostname`
 *   ANDROID_SDK_ROOT      default /opt/android-sdk
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AGENT_VERSION = '1.0.0'
const TOKEN = process.env.ANDROID_AGENT_TOKEN ?? ''
const CONTROLLER = (process.env.PROXBOX_CONTROLLER ?? '').replace(/\/$/, '')
const PORT = Number(process.env.ANDROID_AGENT_PORT ?? 9599)
const NODE_NAME = process.env.ANDROID_NODE_NAME ?? os.hostname().split('.')[0]
const SDK_ROOT = process.env.ANDROID_SDK_ROOT ?? '/opt/android-sdk'
const HEARTBEAT_MS = Number(process.env.ANDROID_HEARTBEAT_MS ?? 15000)
const ADB = process.env.ADB_PATH ?? 'adb'

if (!TOKEN) {
  console.error('ANDROID_AGENT_TOKEN is not set - refusing to start. The controller and the agent must share one.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// running things
// ---------------------------------------------------------------------------

/** Run a command with an argv array. Never a shell - see the header. */
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: { ...process.env, ANDROID_SDK_ROOT: SDK_ROOT, ANDROID_HOME: SDK_ROOT } })
    const out = []
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      child.kill('SIGKILL')
      err += `\n(timed out after ${Math.round((opts.timeoutMs ?? 60000) / 1000)}s)`
    }, opts.timeoutMs ?? 60000)
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => (err += d.toString('utf8')))
    child.on('error', e => {
      done = true
      clearTimeout(timer)
      resolve({ code: 127, stdout: Buffer.alloc(0), stderr: `${cmd}: ${e.message}` })
    })
    child.on('close', code => {
      done = true
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: err })
    })
    if (opts.stdin) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })
}

async function text(cmd, args, timeoutMs = 15000) {
  const r = await run(cmd, args, { timeoutMs })
  return r.code === 0 ? r.stdout.toString('utf8') : ''
}

function has(bin) {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', `command -v ${bin.replace(/[^A-Za-z0-9_./-]/g, '')} >/dev/null 2>&1`])
    child.on('close', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * adb, with the controller's argv. "@stdin" anywhere in the args is replaced by
 * a temp file holding the request body - that is how an APK gets installed
 * without the controller having to stage files on this node itself.
 */
async function adb(serial, args, stdin, timeoutMs) {
  let tmp = null
  let finalArgs = args
  if (args.includes('@stdin')) {
    tmp = path.join(os.tmpdir(), `proxbox-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.writeFileSync(tmp, stdin ?? Buffer.alloc(0))
    finalArgs = args.map(a => (a === '@stdin' ? tmp : a))
  }
  try {
    const full = serial ? ['-s', serial, ...finalArgs] : finalArgs
    return await run(ADB, full, { timeoutMs: timeoutMs ?? 60000 })
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true })
  }
}

// ---------------------------------------------------------------------------
// what this node can do
// ---------------------------------------------------------------------------

async function nodeCapabilities() {
  const cpuinfo = safeRead('/proc/cpuinfo')
  const meminfo = safeRead('/proc/meminfo')
  const flags = (cpuinfo.match(/^flags\s*:.*$/m) ?? [''])[0]
  const memTotal = Number((meminfo.match(/MemTotal:\s+(\d+)/) ?? [0, 0])[1]) / 1024
  const memAvail = Number((meminfo.match(/MemAvailable:\s+(\d+)/) ?? [0, 0])[1]) / 1024

  const [adbVersion, scrcpyVersion, hasEmulator, hasQemu, hasWaydroid, hasAdb] = await Promise.all([
    text(ADB, ['version'], 5000),
    text('scrcpy', ['--version'], 5000),
    Promise.resolve(exists(path.join(SDK_ROOT, 'emulator', 'emulator'))),
    has('qemu-system-x86_64'),
    has('waydroid'),
    has(ADB)
  ])

  // A GPU we can actually use for rendering shows up as a DRI render node.
  const dri = exists('/dev/dri/renderD128')
  const gpuLine = (await text('sh', ['-c', 'lspci 2>/dev/null | grep -i -m1 "vga\\|3d\\|display"'], 5000)).trim()

  return {
    node: NODE_NAME,
    agentVersion: AGENT_VERSION,
    endpoint: `http://${NODE_NAME}:${PORT}`,
    arch: os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'x86_64' : 'x86',
    cpuModel: (cpuinfo.match(/^model name\s*:\s*(.+)$/m) ?? [, ''])[1].trim(),
    cores: os.cpus().length,
    ramMb: Math.round(memTotal),
    freeRamMb: Math.round(memAvail),
    storageFreeGb: await freeGb('/var/lib/vz'),
    kvm: exists('/dev/kvm'),
    nestedKvm:
      safeRead('/sys/module/kvm_intel/parameters/nested').trim().match(/^[Y1]/) !== null ||
      safeRead('/sys/module/kvm_amd/parameters/nested').trim().match(/^[Y1]/) !== null,
    vtx: flags.includes(' vmx'),
    svm: flags.includes(' svm'),
    gpu: {
      vendor: /intel/i.test(gpuLine) ? 'Intel' : /nvidia/i.test(gpuLine) ? 'NVIDIA' : /amd|radeon/i.test(gpuLine) ? 'AMD' : undefined,
      model: gpuLine.replace(/^.*?:\s*/, '').slice(0, 80) || undefined,
      opengl: dri,
      vaapi: dri && (await has('vainfo')),
      quickSync: dri && /intel/i.test(gpuLine),
      vulkan: await has('vulkaninfo')
    },
    runtimes: {
      'android-emulator': hasEmulator && exists('/dev/kvm'),
      qemu: hasQemu,
      waydroid: hasWaydroid,
      'physical-adb': hasAdb
    },
    usbHost: exists('/dev/bus/usb'),
    usbip: await has('usbip'),
    adbVersion: (adbVersion.split('\n')[0] ?? '').replace('Android Debug Bridge version ', '').trim() || undefined,
    scrcpyVersion: (scrcpyVersion.split('\n')[0] ?? '').trim() || undefined,
    cachedImages: listSystemImages()
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function freeGb(dir) {
  const out = await text('df', ['-BG', '--output=avail', dir], 5000)
  const m = out.match(/(\d+)G/)
  return m ? Number(m[1]) : undefined
}

/**
 * Which emulator system images are already on this node, named the way the
 * registry names them ("system-images;android-35;default;x86_64"). The
 * scheduler uses this to prefer a node that does not have to download 1.5 GB.
 */
function listSystemImages() {
  const root = path.join(SDK_ROOT, 'system-images')
  const out = []
  try {
    for (const api of fs.readdirSync(root)) {
      for (const tag of fs.readdirSync(path.join(root, api))) {
        for (const abi of fs.readdirSync(path.join(root, api, tag))) {
          out.push(`system-images;${api};${tag};${abi}`)
        }
      }
    }
  } catch {
    /* no SDK on this node - that is a fine answer */
  }
  return out
}

// ---------------------------------------------------------------------------
// discovering physical devices
// ---------------------------------------------------------------------------

async function listDevices() {
  const raw = await text(ADB, ['devices', '-l'], 15000)
  const rows = []
  for (const line of raw.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)(.*)$/)
    if (!m) continue
    const [, serial, state, rest] = m
    if (state === 'offline' && !serial.includes(':')) continue
    rows.push({
      serial,
      state,
      connection: serial.includes(':') ? 'tcp' : 'usb',
      product: (rest.match(/product:(\S+)/) ?? [, undefined])[1],
      device: (rest.match(/device:(\S+)/) ?? [, undefined])[1],
      model: (rest.match(/model:(\S+)/) ?? [, undefined])[1]
    })
  }
  // Fill in the detail for anything actually usable. Unauthorised devices are
  // reported as-is: the controller turns that into "tap Allow on the device".
  const detailed = await Promise.all(
    rows.map(async row => (row.state === 'device' ? { ...row, ...(await describe(row.serial)) } : row))
  )
  return detailed
}

async function describe(serial) {
  const props = await text(ADB, ['-s', serial, 'shell', 'getprop'], 15000)
  const get = key => {
    const m = props.match(new RegExp(`\\[${key.replace(/\./g, '\\.')}\\]:\\s*\\[(.*)\\]`))
    return m ? m[1] : undefined
  }
  const [sizeOut, densityOut, battery, meminfo, df] = await Promise.all([
    text(ADB, ['-s', serial, 'shell', 'wm', 'size'], 10000),
    text(ADB, ['-s', serial, 'shell', 'wm', 'density'], 10000),
    text(ADB, ['-s', serial, 'shell', 'dumpsys', 'battery'], 10000),
    text(ADB, ['-s', serial, 'shell', 'cat', '/proc/meminfo'], 10000),
    text(ADB, ['-s', serial, 'shell', 'df', '/data'], 10000)
  ])
  // "Override size" wins when present - that is what wm size actually applied.
  const size = (sizeOut.match(/Override size:\s*(\d+)x(\d+)/) ?? sizeOut.match(/Physical size:\s*(\d+)x(\d+)/)) ?? null
  const density = densityOut.match(/(?:Override|Physical) density:\s*(\d+)/)
  const abi = get('ro.product.cpu.abi') ?? ''
  return {
    manufacturer: get('ro.product.manufacturer'),
    model: get('ro.product.model'),
    product: get('ro.product.name'),
    androidVersion: get('ro.build.version.release'),
    apiLevel: Number(get('ro.build.version.sdk') ?? 0) || undefined,
    arch: abi.startsWith('arm64') ? 'arm64' : abi.startsWith('arm') ? 'arm' : abi.includes('x86_64') ? 'x86_64' : abi ? 'x86' : undefined,
    characteristics: get('ro.build.characteristics'),
    display: size
      ? {
          width: Number(size[1]),
          height: Number(size[2]),
          dpi: Number(density?.[1] ?? 0) || 320,
          orientation: Number(size[1]) > Number(size[2]) ? 'landscape' : 'portrait'
        }
      : undefined,
    batteryPct: Number((battery.match(/level:\s*(\d+)/) ?? [, 0])[1]) || undefined,
    charging: /AC powered:\s*true|USB powered:\s*true/.test(battery),
    ramMb: Math.round(Number((meminfo.match(/MemTotal:\s+(\d+)/) ?? [, 0])[1]) / 1024) || undefined,
    storageGb: Math.round(Number((df.match(/\s(\d+)\s+\d+%/) ?? [, 0])[1]) / 1024 / 1024) || undefined
  }
}

// ---------------------------------------------------------------------------
// emulator lifecycle
// ---------------------------------------------------------------------------

const emulators = new Map() // avd name -> { child, serial, port }

async function ensureSdkPackage(packageName) {
  if (listSystemImages().includes(packageName)) return { ok: true, installed: false }
  const sdkmanager = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
  if (!exists(sdkmanager)) throw new Error(`No sdkmanager at ${sdkmanager} - this node cannot fetch system images.`)
  const r = await run('sh', ['-c', `yes | "${sdkmanager}" --install "${packageName}"`], { timeoutMs: 1_800_000 })
  if (r.code !== 0) throw new Error(`sdkmanager failed: ${r.stderr.slice(0, 300)}`)
  return { ok: true, installed: true }
}

async function createAvd(spec) {
  const avdmanager = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
  if (!exists(avdmanager)) throw new Error(`No avdmanager at ${avdmanager}.`)
  await ensureSdkPackage(spec.packageName)
  const r = await run(
    'sh',
    ['-c', `echo no | "${avdmanager}" create avd -n "${spec.name}" -k "${spec.packageName}" --force`],
    { timeoutMs: 300_000 }
  )
  if (r.code !== 0) throw new Error(`avdmanager failed: ${r.stderr.slice(0, 300)}`)

  // The skin IS the device shape: width, height and density are the only
  // things that make this AVD a phone rather than a 13" tablet.
  const cfg = path.join(os.homedir(), '.android', 'avd', `${spec.name}.avd`, 'config.ini')
  const props = {
    'hw.lcd.width': String(spec.width),
    'hw.lcd.height': String(spec.height),
    'hw.lcd.density': String(spec.dpi),
    'hw.ramSize': String(spec.ramMb),
    'hw.cpu.ncore': String(spec.cores),
    'disk.dataPartition.size': `${spec.storageGb}G`,
    'skin.name': `${spec.width}x${spec.height}`,
    'skin.dynamic': 'yes',
    'showDeviceFrame': 'no',
    ...(spec.hardware ?? {})
  }
  mergeIni(cfg, props)
  return { avd: spec.name }
}

function mergeIni(file, props) {
  let lines = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    /* fresh file */
  }
  const seen = new Set()
  const out = lines.map(line => {
    const key = line.split('=')[0]?.trim()
    if (key && key in props) {
      seen.add(key)
      return `${key}=${props[key]}`
    }
    return line
  })
  for (const [k, v] of Object.entries(props)) if (!seen.has(k)) out.push(`${k}=${v}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, out.filter(l => l !== '').join('\n') + '\n')
}

async function startAvd(body) {
  const { avd, gpu = 'auto', headless = true, wipeData = false, snapshot } = body
  if (emulators.has(avd)) return emulators.get(avd).info
  const port = await freeEmulatorPort()
  const args = [
    '-avd', avd,
    '-port', String(port),
    '-gpu', gpu,
    '-no-boot-anim',
    '-no-audio'
  ]
  if (headless) args.push('-no-window')
  if (wipeData) args.push('-wipe-data')
  if (snapshot) args.push('-snapshot', snapshot)

  const bin = path.join(SDK_ROOT, 'emulator', 'emulator')
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANDROID_SDK_ROOT: SDK_ROOT, ANDROID_HOME: SDK_ROOT }
  })
  child.unref()
  const info = { serial: `emulator-${port}`, port }
  emulators.set(avd, { child, info })
  // Let adb notice it; the controller polls for boot completion itself.
  await adb(null, ['start-server'], null, 15000)
  return info
}

/** Emulator serials are even ports from 5554 up; find one nothing is using. */
async function freeEmulatorPort() {
  const raw = await text(ADB, ['devices'], 10000)
  const used = new Set([...raw.matchAll(/emulator-(\d+)/g)].map(m => Number(m[1])))
  for (const p of emulators.values()) used.add(p.info.port)
  for (let port = 5554; port <= 5680; port += 2) if (!used.has(port)) return port
  throw new Error('This node has no free emulator ports left (5554-5680 are all in use).')
}

async function stopAvd(avd) {
  const entry = emulators.get(avd)
  if (entry) {
    await adb(entry.info.serial, ['emu', 'kill'], null, 15000).catch(() => {})
    emulators.delete(avd)
  }
  return { ok: true }
}

async function deleteAvd(avd) {
  await stopAvd(avd)
  const avdmanager = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
  await run(avdmanager, ['delete', 'avd', '-n', avd], { timeoutMs: 60000 })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// finding an Android VM on the bridge
// ---------------------------------------------------------------------------

/**
 * Android VMs have no guest agent, so the controller picks the MAC and asks us
 * to find it. The neighbour table usually already knows; when it does not, a
 * broadcast ping makes every live host on the bridge answer, and then it does.
 */
async function ipForMac(mac) {
  const want = mac.toLowerCase()
  const find = async () => {
    const out = await text('ip', ['neigh', 'show'], 10000)
    for (const line of out.split('\n')) {
      if (!line.toLowerCase().includes(want)) continue
      const m = line.match(/^(\d+\.\d+\.\d+\.\d+)/)
      if (m) return m[1]
    }
    return null
  }
  let ip = await find()
  if (ip) return { ip }
  // Nudge the table: ping the broadcast address of every bridge we have.
  const addrs = await text('sh', ['-c', "ip -4 -o addr show | awk '{print $4}'"], 10000)
  await Promise.all(
    addrs
      .split('\n')
      .filter(a => a.includes('/') && !a.startsWith('127.'))
      .slice(0, 4)
      .map(cidr => run('ping', ['-c', '2', '-b', '-w', '2', broadcastOf(cidr)], { timeoutMs: 6000 }).catch(() => {}))
  )
  ip = await find()
  return { ip: ip ?? undefined }
}

function broadcastOf(cidr) {
  const [addr, bits] = cidr.split('/')
  const octets = addr.split('.').map(Number)
  const maskBits = Number(bits)
  const mask = [0, 0, 0, 0].map((_, i) => {
    const b = Math.min(8, Math.max(0, maskBits - i * 8))
    return 255 - (255 >> b)
  })
  return octets.map((o, i) => (o & mask[i]) | (255 - mask[i])).join('.')
}

// ---------------------------------------------------------------------------
// the signed local API
// ---------------------------------------------------------------------------

function verify(req, body) {
  const ts = req.headers['x-proxbox-ts']
  const sig = req.headers['x-proxbox-sig']
  if (!ts || !sig) return false
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const expected = createHmac('sha256', TOKEN)
    .update(`${ts}\n${req.method}\n${new URL(req.url, 'http://x').pathname}\n${bodyHash}`)
    .digest('hex')
  const a = Buffer.from(String(sig))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks)
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (!verify(req, body)) return send(401, { message: 'Bad signature' })
    const url = new URL(req.url, 'http://x')
    let payload = {}
    if (body.length) {
      try {
        payload = JSON.parse(body.toString('utf8'))
      } catch {
        return send(400, { message: 'Body was not JSON' })
      }
    }
    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /capabilities':
          return send(200, await nodeCapabilities())
        case 'GET /devices':
          return send(200, await listDevices())
        case 'POST /adb': {
          const r = await adb(
            payload.serial,
            payload.args ?? [],
            payload.stdin ? Buffer.from(payload.stdin, 'base64') : null,
            payload.timeoutMs
          )
          return send(200, { code: r.code, stdout: r.stdout.toString('base64'), stderr: r.stderr })
        }
        case 'POST /connect': {
          const r = await adb(null, ['connect', String(payload.target)], null, 20000)
          const out = r.stdout.toString('utf8')
          return send(200, { ok: /connected to/i.test(out), message: out.trim() })
        }
        case 'POST /disconnect': {
          await adb(null, ['disconnect', String(payload.target)], null, 20000)
          return send(200, { ok: true })
        }
        case 'POST /net/ip-for-mac':
          return send(200, await ipForMac(String(payload.mac ?? '')))
        case 'POST /sdk/ensure':
          return send(200, await ensureSdkPackage(String(payload.packageName)))
        case 'POST /avd/create':
          return send(200, await createAvd(payload))
        case 'POST /avd/start':
          return send(200, await startAvd(payload))
        case 'POST /avd/stop':
          return send(200, await stopAvd(String(payload.avd)))
        case 'POST /avd/delete':
          return send(200, await deleteAvd(String(payload.avd)))
        default:
          return send(404, { message: `No such agent endpoint: ${req.method} ${url.pathname}` })
      }
    } catch (err) {
      return send(500, { message: err instanceof Error ? err.message : String(err) })
    }
  })
})

server.listen(PORT, () => console.log(`[proxbox-android-agent] ${AGENT_VERSION} listening on :${PORT} as node "${NODE_NAME}"`))

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

async function heartbeat() {
  if (!CONTROLLER) return
  const caps = await nodeCapabilities()
  const devices = await listDevices().catch(() => [])
  const payload = JSON.stringify({ ...caps, devices })
  const p = '/svc/android/agent/heartbeat'
  const ts = String(Date.now())
  const bodyHash = createHash('sha256').update(payload).digest('hex')
  const sig = createHmac('sha256', TOKEN).update(`${ts}\nPOST\n${p}\n${bodyHash}`).digest('hex')
  try {
    const r = await fetch(`${CONTROLLER}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proxbox-ts': ts, 'x-proxbox-sig': sig },
      body: payload
    })
    if (!r.ok) console.error(`[proxbox-android-agent] heartbeat rejected: HTTP ${r.status}`)
  } catch (err) {
    console.error('[proxbox-android-agent] heartbeat failed:', err.message)
  }
}

heartbeat()
setInterval(heartbeat, HEARTBEAT_MS)
