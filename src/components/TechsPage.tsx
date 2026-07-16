import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'

interface PveUser {
  userid: string
  comment?: string
  enable?: number
}

interface AclEntry {
  path: string
  ugid: string
  roleid: string
}

const TECH_ROLE = 'PVEVMAdmin'

/** Grants (or re-grants) the standard tech role. Proxmox treats this as idempotent. */
async function grantTechRole(userid: string): Promise<void> {
  await api('/access/acl', { method: 'PUT', params: { path: '/', users: userid, roles: TECH_ROLE } })
}

/**
 * Root-only: create/remove tech logins. Each tech becomes a real Proxmox user
 * in the "pve" realm with the PVEVMAdmin role - enough to spin up, snapshot,
 * start/stop and connect to machines through this app, nothing node-level.
 */
export default function TechsPage({ onClose }: { onClose: () => void }) {
  const [techs, setTechs] = useState<PveUser[]>([])
  const [grantedIds, setGrantedIds] = useState<Set<string>>(new Set())
  const [newUser, setNewUser] = useState('')
  const [newPass, setNewPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fixingId, setFixingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [users, acl] = await Promise.all([
        api<PveUser[]>('/access/users'),
        api<AclEntry[]>('/access/acl')
      ])
      setTechs(users.filter(u => u.userid.endsWith('@pve')).sort((a, b) => a.userid.localeCompare(b.userid)))
      // Who actually has the tech role at the root path - this is the exact
      // check that would have caught CDrage/DSamson before anyone hit a wall.
      setGrantedIds(new Set(acl.filter(a => a.path === '/' && a.roleid === TECH_ROLE).map(a => a.ugid)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function addTech(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    const userid = `${newUser.trim()}@pve`
    try {
      await api('/access/users', {
        method: 'POST',
        params: { userid, password: newPass, comment: 'Tech - created via ProxBox', enable: true }
      })

      // Apply the role, then verify it actually landed rather than trusting
      // a 200 - this exact gap (user created, ACL silently never applied)
      // is how two existing techs ended up locked out with no one noticing.
      let granted = false
      for (let attempt = 0; attempt < 2 && !granted; attempt++) {
        try {
          await grantTechRole(userid)
          const acl = await api<AclEntry[]>('/access/acl')
          granted = acl.some(a => a.path === '/' && a.roleid === TECH_ROLE && a.ugid === userid)
        } catch {
          // retry once
        }
      }

      if (granted) {
        setNotice(`${userid} is ready - they sign in with username "${newUser.trim()}" and realm "Proxmox VE (pve)".`)
      } else {
        setError(
          `${userid} was created, but granting access didn't verify as applied. ` +
          `They can log in but won't be able to do anything yet - use "Grant access" below to fix it.`
        )
      }
      setNewUser('')
      setNewPass('')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function fixAccess(userid: string) {
    setFixingId(userid)
    try {
      await grantTechRole(userid)
      await load()
    } catch (err) {
      alert(`Couldn't grant access: ${err instanceof Error ? err.message : err}`)
    } finally {
      setFixingId(null)
    }
  }

  async function removeTech(userid: string) {
    if (!confirm(`Remove ${userid}? They immediately lose access. Machines they made are not touched.`)) return
    try {
      await api(`/access/users/${encodeURIComponent(userid)}`, { method: 'DELETE' })
      load()
    } catch (err) {
      alert(`Couldn't remove: ${err instanceof Error ? err.message : err}`)
    }
  }

  async function resetPass(userid: string) {
    const p = prompt(`New password for ${userid}:`)
    if (!p) return
    try {
      await api('/access/password', { method: 'PUT', params: { userid, password: p } })
      alert(`Password updated for ${userid}.`)
    } catch (err) {
      alert(`Couldn't update password: ${err instanceof Error ? err.message : err}`)
    }
  }

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-head">
          <h2>Techs</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="muted">
          Give a tech a login and they can use this app to spin machines up, snapshot them and connect.
          They never see the Proxmox admin UI or these controls.
        </p>

        <form className="grid2 tech-form" onSubmit={addTech}>
          <label>
            Tech username
            <input
              value={newUser}
              onChange={e => setNewUser(e.target.value)}
              placeholder="e.g. sarah"
              pattern="[A-Za-z0-9_\-]+"
              title="Letters, digits and dashes and underscores"
              required
            />
          </label>
          <label>
            Password
            <input value={newPass} onChange={e => setNewPass(e.target.value)} minLength={5} required />
          </label>
          <div className="tech-form-foot">
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Add tech'}</button>
          </div>
        </form>

        {notice && <p className="good-note">✔ {notice}</p>}
        {error && <p className="error" role="alert">⚠ {error}</p>}

        <div>
          {techs.length === 0 && <p className="muted">No tech logins yet.</p>}
          {techs.map(t => {
            const hasAccess = grantedIds.has(t.userid)
            return (
              <div key={t.userid} className="tech-row">
                <strong>{t.userid}</strong>
                {t.enable === 0 && <span className="warn">disabled</span>}
                {!hasAccess && <span className="error">⚠ no VM access granted</span>}
                <span className="snap-spacer" />
                {!hasAccess && (
                  <button className="small primary" onClick={() => fixAccess(t.userid)} disabled={fixingId === t.userid}>
                    {fixingId === t.userid ? 'Granting…' : 'Grant access'}
                  </button>
                )}
                <button className="small" onClick={() => resetPass(t.userid)}>Reset password</button>
                <button className="small danger" onClick={() => removeTech(t.userid)}>Remove</button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
