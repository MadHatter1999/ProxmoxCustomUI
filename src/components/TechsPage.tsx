import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'

interface PveUser {
  userid: string
  comment?: string
  enable?: number
}

/**
 * Root-only: create/remove tech logins. Each tech becomes a real Proxmox user
 * in the "pve" realm with the PVEVMAdmin role - enough to spin up, snapshot,
 * start/stop and connect to machines through this app, nothing node-level.
 */
export default function TechsPage({ onClose }: { onClose: () => void }) {
  const [techs, setTechs] = useState<PveUser[]>([])
  const [newUser, setNewUser] = useState('')
  const [newPass, setNewPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    api<PveUser[]>('/access/users')
      .then(list => setTechs(list.filter(u => u.userid.endsWith('@pve')).sort((a, b) => a.userid.localeCompare(b.userid))))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
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
      await api('/access/acl', {
        method: 'PUT',
        params: { path: '/', users: userid, roles: 'PVEVMAdmin' }
      })
      setNotice(`${userid} is ready - they sign in with username "${newUser.trim()}" and realm "Proxmox VE (pve)".`)
      setNewUser('')
      setNewPass('')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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
              title="Letters, digits, dashes and underscores"
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
          {techs.map(t => (
            <div key={t.userid} className="tech-row">
              <strong>{t.userid}</strong>
              {t.enable === 0 && <span className="warn">disabled</span>}
              <span className="snap-spacer" />
              <button className="small" onClick={() => resetPass(t.userid)}>Reset password</button>
              <button className="small danger" onClick={() => removeTech(t.userid)}>Remove</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
