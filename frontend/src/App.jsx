import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { DEV_USER } from './api.js'
import { useSession } from './session.jsx'
import { Banner } from './ui.jsx'
import QuickCreate from './components/QuickCreate.jsx'
import MyActions from './pages/MyActions.jsx'
import Prospects from './pages/Prospects.jsx'
import ProspectRecord from './pages/ProspectRecord.jsx'
import Pipeline from './pages/Pipeline.jsx'
import OpportunityRecord from './pages/OpportunityRecord.jsx'
import Accounts from './pages/Accounts.jsx'
import AccountRecord from './pages/AccountRecord.jsx'
import Views from './pages/Views.jsx'

const NAV = [
  ['Daily work', [['/', 'My Actions'], ['/prospects', 'Prospects'], ['/pipeline', 'Pipeline'], ['/accounts', 'Accounts']]],
  ['Views & reporting', [['/views', 'Forecast & views']]],
]

function Login() {
  const { signIn, error } = useSession()
  const btn = useRef(null)
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const [gsiError, setGsiError] = useState('')

  useEffect(() => {
    if (!clientId) return
    const init = () => {
      window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => signIn(r.credential), auto_select: true })
      window.google.accounts.id.renderButton(btn.current, { theme: 'outline', size: 'large', text: 'signin_with' })
    }
    if (window.google?.accounts?.id) return init()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = init
    s.onerror = () => setGsiError('Couldn’t load Google sign-in. Check your connection.')
    document.head.appendChild(s)
  }, [clientId, signIn])

  return (
    <div className="login">
      <div className="card strong">
        <div className="nav-brand" style={{ padding: 0, color: 'var(--ink)' }}>LeadStrategus <span className="nav-chip" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>CRM</span></div>
        <p className="muted" style={{ margin: 0 }}>Sign in with your LeadStrategus Google Workspace account.</p>
        {error && <Banner kind="err">{error}</Banner>}
        {gsiError && <Banner kind="err">{gsiError}</Banner>}
        {clientId ? <div ref={btn} /> : <Banner kind="warn">Google sign-in isn’t configured: set VITE_GOOGLE_CLIENT_ID (or VITE_DEV_USER for local dev).</Banner>}
      </div>
    </div>
  )
}

export default function App() {
  const session = useSession()
  const [quick, setQuick] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  if (session.status === 'loading') return <div className="loading">Loading the CRM…</div>
  if (session.status !== 'ready') return <Login />

  const { user } = session
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="nav-brand">LeadStrategus <span className="nav-chip">CRM</span></div>
        {NAV.map(([group, links]) => (
          <div key={group}>
            <div className="nav-group-title">{group}</div>
            <div className="nav-links">
              {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
            </div>
          </div>
        ))}
        <div className="nav-foot">
          <span>{user.name} · {user.role}{DEV_USER ? ' (dev sign-in)' : ''}</span>
          <button type="button" onClick={session.signOut}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <div className="topbar">
          <span className="muted small">Every active prospect and open opportunity needs an owner, a next action and a due date.</span>
          <div className="row">
            {['account', 'prospect', 'opportunity'].map((t) => (
              <button key={t} type="button" className="btn btn-outline" onClick={() => setQuick(t)}>+ {t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </div>
        <Routes key={refreshKey}>
          <Route path="/" element={<MyActions />} />
          <Route path="/prospects" element={<Prospects />} />
          <Route path="/prospects/:id" element={<ProspectRecord />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/opportunities/:id" element={<OpportunityRecord />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:id" element={<AccountRecord />} />
          <Route path="/views" element={<Views />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {quick && <QuickCreate type={quick} onClose={() => setQuick(null)} onCreated={() => setRefreshKey((k) => k + 1)} />}
    </div>
  )
}
