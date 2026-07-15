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
