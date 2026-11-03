import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import CommandPalette, { type PaletteCommand } from './components/CommandPalette'
import { Avatar, useTheme } from './theme'
import { DEV_USER } from './api'
import { useSessionState } from './session'
import { Banner } from './ui'
import QuickCreate, { type QuickType } from './components/QuickCreate'
import MyActions from './pages/MyActions'
import Prospects from './pages/Prospects'
import ProspectRecord from './pages/ProspectRecord'
import Pipeline from './pages/Pipeline'
import OpportunityRecord from './pages/OpportunityRecord'
import Accounts from './pages/Accounts'
import AccountRecord from './pages/AccountRecord'
import Views from './pages/Views'
import Reports from './pages/Reports'
import Meetings from './pages/Meetings'
import Settings from './pages/Settings'
import Import from './pages/Import'
import Cleanup from './pages/Cleanup'

// Icon rail: [path, full name (tooltip + screen readers), short label, icon path].
type NavItem = [string, string, string, string]
const NAV: NavItem[][] = [
  [
    ['/', 'My Actions', 'Actions', 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
    ['/prospects', 'Prospects', 'Prospects', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
    ['/pipeline', 'Pipeline', 'Pipeline', 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z'],
    ['/accounts', 'Accounts', 'Accounts', 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6'],
  ],
  [
    ['/views', 'Forecast & views', 'Forecast', 'M3 3v18h18M7 15l4-4 3 3 5-6'],
    ['/reports', 'Reports', 'Reports', 'M4 20V10M10 20V4M16 20v-8M22 20H2'],
    ['/cleanup', 'Needs cleanup', 'Cleanup', 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0'],
  ],
  [
    ['/meetings', 'Meetings & booking', 'Meetings', 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2'],
    ['/settings', 'Settings', 'Settings', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4'],
    ['/import', 'Import from HubSpot', 'Import', 'M12 3v12M7 10l5 5 5-5M5 21h14'],
  ],
]


function Login() {
  const { signIn, error } = useSessionState()
  const btn = useRef<HTMLDivElement>(null)
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const [gsiError, setGsiError] = useState('')

  useEffect(() => {
    if (!clientId) return
    const init = () => {
      const gid = window.google?.accounts.id
      if (!gid || !btn.current) return
      gid.initialize({ client_id: clientId, callback: (r) => signIn(r.credential), auto_select: true })
      gid.renderButton(btn.current, { theme: 'outline', size: 'large', text: 'signin_with' })
    }
    if (window.google?.accounts.id) { init(); return }
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
        <div className="row" style={{ gap: 12 }}><span className="rail-brand" style={{ margin: 0 }}>LS</span><strong style={{ fontSize: 20 }}>LeadStrategus CRM</strong></div>
        <p className="muted" style={{ margin: 0 }}>Sign in with your LeadStrategus Google Workspace account.</p>
        {error && <Banner kind="err">{error}</Banner>}
        {gsiError && <Banner kind="err">{gsiError}</Banner>}
        {clientId ? <div ref={btn} /> : <Banner kind="warn">Google sign-in isn’t configured: set VITE_GOOGLE_CLIENT_ID (or VITE_DEV_USER for local dev).</Banner>}
      </div>
    </div>
  )
}

export default function App() {
  const session = useSessionState()
  const [quick, setQuick] = useState<QuickType | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const location = useLocation()
  const navigate = useNavigate()
  const [theme, toggleTheme] = useTheme()
  const [palette, setPalette] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (session.status === 'loading') return <div className="loading">Loading the CRM… (the server may take up to a minute to wake up)</div>
  if (session.status !== 'ready' || !session.user) return <Login />

  const { user } = session
  const close = () => setPalette(false)
  const commands: PaletteCommand[] = [
    ...NAV.flat().map(([to, label]) => ({ id: `nav-${to}`, group: 'Go to', label, run: () => { navigate(to); close() } })),
    { id: 'new-deal', group: 'Create', label: 'New deal', run: () => { setQuick('opportunity'); close() } },
    { id: 'new-prospect', group: 'Create', label: 'New prospect', run: () => { setQuick('prospect'); close() } },
    { id: 'new-account', group: 'Create', label: 'New account', run: () => { setQuick('account'); close() } },
    { id: 'theme', group: 'Preferences', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', run: () => { toggleTheme(); close() } },
  ]
  return (
    <MotionConfig reducedMotion="user">
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <NavLink to="/" className="rail-brand" aria-label="LeadStrategus CRM home" title="LeadStrategus CRM">LS</NavLink>
        {NAV.map((group, gi) => (
          <div key={gi} style={{ display: 'contents' }}>
            {gi > 0 && <span className="rail-sep" aria-hidden="true" />}
            {group.map(([to, label, short, icon]) => (
              <NavLink key={to} to={to} end={to === '/'} className="rail-link" data-tip={label} aria-label={label}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
                <span aria-hidden="true">{short}</span>
              </NavLink>
            ))}
          </div>
        ))}
        <div className="rail-foot">
          <button type="button" className="theme-toggle" onClick={toggleTheme} data-tip={theme === 'dark' ? 'Light mode' : 'Dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark'
              ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
          </button>
          <Avatar name={user.name} size={36} />
          <button type="button" onClick={session.signOut}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <div className="topbar">
          <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <span>Search deals, people, pages…</span><kbd>Ctrl K</kbd>
          </button>
          <span className="who"><Avatar name={user.name} size={32} /><span>{user.name}<span className="muted small" style={{ fontWeight: 600 }}> · {user.role}{DEV_USER ? ' (dev sign-in)' : ''}</span></span></span>
          <div className="row">
            {(['account', 'prospect'] as const).map((t) => (
              <button key={t} type="button" className="btn" onClick={() => setQuick(t)}>+ {t[0].toUpperCase() + t.slice(1)}</button>
            ))}
            <button type="button" className="btn btn-primary" onClick={() => setQuick('opportunity')}>+ New deal</button>
          </div>
        </div>
        <div className="page-enter" key={location.pathname}>
        <Routes key={refreshKey}>
          <Route path="/" element={<MyActions />} />
          <Route path="/prospects" element={<Prospects />} />
          <Route path="/prospects/:id" element={<ProspectRecord />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/opportunities/:id" element={<OpportunityRecord />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:id" element={<AccountRecord />} />
          <Route path="/views" element={<Views />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/import" element={<Import />} />
          <Route path="/cleanup" element={<Cleanup />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </div>
      </main>
      <CommandPalette open={palette} onClose={close} commands={commands} />
      {quick && <QuickCreate type={quick} onClose={() => setQuick(null)} onCreated={() => setRefreshKey((k) => k + 1)} />}
    </div>
    </MotionConfig>
  )
}
