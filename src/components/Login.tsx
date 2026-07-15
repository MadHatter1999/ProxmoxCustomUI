import { useState, type FormEvent } from 'react'
import { login, type Session } from '../api'

export default function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState('root')
  const [password, setPassword] = useState('')
  const [realm, setRealm] = useState('pam')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onLogin(await login(username, password, realm))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>The Proxbox</h1>
        <p className="sub">Spin up a machine. Connect. Get to work.</p>
        <label>
          Username
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          Realm
          <select value={realm} onChange={e => setRealm(e.target.value)}>
            <option value="pam">Linux PAM (pam)</option>
            <option value="pve">Proxmox VE (pve)</option>
          </select>
        </label>
        {error && <p className="error" role="alert">⚠ {error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
