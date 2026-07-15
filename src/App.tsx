import { useCallback, useState } from 'react'
import { clearSession, restoreSession, type Session } from './api'
import Login from './components/Login'
import Dashboard from './components/Dashboard'

export default function App() {
  const [session, setSession] = useState<Session | null>(() => restoreSession())

  const handleLogout = useCallback(() => {
    clearSession()
    setSession(null)
  }, [])

  if (!session) return <Login onLogin={setSession} />
  return <Dashboard session={session} onLogout={handleLogout} />
}
