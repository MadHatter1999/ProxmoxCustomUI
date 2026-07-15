export class AuthError extends Error {
  constructor() {
    super('Session expired - please log in again')
  }
}

export interface Session {
  username: string
  csrf: string
}

let csrfToken = ''

export function restoreSession(): Session | null {
  const username = sessionStorage.getItem('pve-user')
  const csrf = sessionStorage.getItem('pve-csrf')
  if (!username || !csrf || !document.cookie.includes('PVEAuthCookie=')) return null
  csrfToken = csrf
  return { username, csrf }
}

export function clearSession() {
  csrfToken = ''
  sessionStorage.removeItem('pve-user')
  sessionStorage.removeItem('pve-csrf')
  document.cookie = 'PVEAuthCookie=; path=/; max-age=0'
}

export async function login(username: string, password: string, realm: string): Promise<Session> {
  const body = new URLSearchParams({ username: `${username}@${realm}`, password })
  const r = await fetch('/api2/json/access/ticket', { method: 'POST', body })
  if (!r.ok) throw new Error(r.status === 401 ? 'Wrong username or password' : `Login failed (HTTP ${r.status})`)
  const d = (await r.json()).data
  csrfToken = d.CSRFPreventionToken
  document.cookie = `PVEAuthCookie=${d.ticket}; path=/; SameSite=Strict`
  sessionStorage.setItem('pve-user', d.username)
  sessionStorage.setItem('pve-csrf', csrfToken)
  return { username: d.username, csrf: csrfToken }
}

type ParamValue = string | number | boolean | undefined | string[]
type Params = Record<string, ParamValue>

function encodeParams(params: Params): URLSearchParams {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach(x => out.append(k, x))
    else out.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  return out
}

export async function api<T>(path: string, opts: { method?: string; params?: Params } = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const encoded = encodeParams(opts.params ?? {})
  let url = `/api2/json${path}`
  const init: RequestInit = { method }
  if (method === 'GET' || method === 'DELETE') {
    const q = encoded.toString()
    if (q) url += `?${q}`
    if (method === 'DELETE') init.headers = { CSRFPreventionToken: csrfToken }
  } else {
    init.headers = { CSRFPreventionToken: csrfToken }
    init.body = encoded
  }
  const r = await fetch(url, init)
  if (r.status === 401) {
    clearSession()
    throw new AuthError()
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j.errors) msg += ' - ' + Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ')
      else if (typeof j.message === 'string') msg += ' - ' + j.message.trim()
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg)
  }
  return (await r.json()).data as T
}

export interface IsoTargetInfo {
  node: string
  storage: string
  pctUsed: number
  freeBytes: number
}

/**
 * Where an uploaded ISO will land and how full that storage is. Goes through
 * the server's /svc route (backed by root's API token) instead of the user's
 * own session, so it works the same for a tech login as it does for root.
 */
export async function fetchIsoTarget(): Promise<IsoTargetInfo | null> {
  const r = await fetch('/svc/iso-target')
  if (r.status === 401) {
    clearSession()
    throw new AuthError()
  }
  if (r.status === 503) return null
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error(j.message ?? `Couldn't check image storage (HTTP ${r.status})`)
  }
  return r.json()
}

/**
 * Uploads a file into the shared image folder (e.g. an ISO into
 * /var/lib/vz/template/iso). Routed through the server's elevated /svc
 * endpoint - see fetchIsoTarget - so any signed-in user can do this, not just
 * accounts with Datastore permissions. Uses XHR instead of fetch for upload
 * progress: these are multi-GB files on a LAN, and a silent multi-minute wait
 * reads as broken.
 */
export function uploadIso(file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/svc/upload-iso')
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        clearSession()
        reject(new AuthError())
        return
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).data as string)
        } catch {
          reject(new Error('Upload finished but the server sent back something unexpected'))
        }
      } else {
        let msg = `Upload failed (HTTP ${xhr.status})`
        try {
          const j = JSON.parse(xhr.responseText)
          if (typeof j.message === 'string') msg += ' - ' + j.message.trim()
        } catch { /* non-JSON error body */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed - connection dropped'))
    const form = new FormData()
    form.append('content', 'iso')
    form.append('filename', file)
    xhr.send(form)
  })
}
