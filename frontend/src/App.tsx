import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import CommandPalette, { type PaletteCommand } from './components/CommandPalette'
import { useTheme } from './theme'
import { useSessionState } from './session'
import { Banner } from './ui'
import QuickCreate, { type QuickType } from './components/QuickCreate'
import ProfileMenu from './components/ProfileMenu'
import MobileNav from './components/MobileNav'
import AppNotices from './components/AppNotices'
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
import Home from './pages/Home'
import Deals from './pages/Deals'
import Activities from './pages/Activities'
import Goals from './pages/Goals'
import DataManagement from './pages/DataManagement'

// Sidebar, grouped the way the CRM review recommends (Workspace / CRM /
// Sales / Analytics & Admin). Item: [path, full name, short label, icon path].
type NavItem = [string, string, string, string]
const I = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  actions: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  contacts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  companies: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6',
  leads: 'M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z',
  deals: 'M20 7h-9M14 17H5M17 21a4 4 0 1 0 0-8 4 4 0 0 0 0 8M7 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  activities: 'M22 12h-4l-3 9L9 3l-3 9H2',
  pipeline: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z',
  forecast: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  goals: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  reports: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  meetings: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
  data: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
}
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  { title: 'Workspace', items: [['/home', 'CRM Home', 'Home', I.home], ['/', 'My Actions', 'Actions', I.actions]] },
  { title: 'CRM', items: [
    ['/contacts', 'Contacts', 'Contacts', I.contacts], ['/companies', 'Companies', 'Companies', I.companies],
    ['/leads', 'Leads / Prospects', 'Leads', I.leads], ['/deals', 'Deals', 'Deals', I.deals],
    ['/activities', 'Activities & Meetings', 'Activities', I.activities]] },
  { title: 'Sales', items: [['/pipeline', 'Sales Pipeline', 'Pipeline', I.pipeline], ['/forecast', 'Forecast', 'Forecast', I.forecast], ['/goals', 'Sales Goals', 'Goals', I.goals]] },
  { title: 'Analytics & Admin', items: [
    ['/reports', 'Reports & Dashboards', 'Reports', I.reports], ['/meetings', 'Meetings & booking', 'Meetings', I.meetings],
    ['/data', 'Data management', 'Data', I.data], ['/settings', 'Settings', 'Settings', I.settings]] },
]
const NAV: NavItem[][] = NAV_GROUPS.map((g) => g.items)

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
  const [navCollapsed, setNavCollapsed] = useState(() => { try { return localStorage.getItem('ls-crm-nav') === 'collapsed' } catch { return false } })
  const toggleNav = () => setNavCollapsed((c) => { try { localStorage.setItem('ls-crm-nav', c ? 'open' : 'collapsed') } catch { /* private mode */ } return !c })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (session.status === 'loading') return <div className="loading">Loading the CRM… (the server may take up to a minute to wake up)</div>
  if (session.status === 'offline') return (
    <div className="login">
      <div className="card strong" role="status">
        <div className="row" style={{ gap: 12 }}><img src="/icons/icon-192.png" alt="" width={44} height={44} style={{ borderRadius: 12 }} /><strong style={{ fontSize: 20 }}>You’re offline</strong></div>
        <p className="muted" style={{ margin: 0 }}>{navigator.onLine ? 'The CRM server isn’t answering yet (it may be waking up).' : 'The CRM needs a connection to show live data.'} It reconnects by itself as soon as it can.</p>
        <button type="button" className="btn btn-dark" style={{ alignSelf: 'flex-start' }} onClick={session.retry}>Try again</button>
      </div>
    </div>
  )
  if (session.status !== 'ready' || !session.user) return <Login />

  const { user } = session
  const close = () => setPalette(false)
  const commands: PaletteCommand[] = [
    ...NAV.flat().map(([to, label]) => ({ id: `nav-${to}`, group: 'Go to', label, run: () => { navigate(to); close() } })),
    { id: 'new-deal', group: 'Create', label: 'New deal', run: () => { setQuick('opportunity'); close() } },
    { id: 'new-prospect', group: 'Create', label: 'New contact / lead', run: () => { setQuick('prospect'); close() } },
    { id: 'new-account', group: 'Create', label: 'New company', run: () => { setQuick('account'); close() } },
    { id: 'theme', group: 'Preferences', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', run: () => { toggleTheme(); close() } },
  ]
  return (
    <MotionConfig reducedMotion="user">
    <div className="shell">
      <nav className={`rail${navCollapsed ? ' collapsed' : ''}`} aria-label="Main">
        <ProfileMenu user={user} theme={theme} onToggleTheme={toggleTheme} onSignOut={session.signOut} />
        <span className="rail-sep" aria-hidden="true" />
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="nav-group">
            <span className="nav-title">{group.title}</span>
            {group.items.map(([to, label, short, icon]) => (
              <NavLink key={to} to={to} end={to === '/'} className="rail-link" data-tip={label} aria-label={label}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
                <span className="nav-label" aria-hidden="true">{label}</span><span className="nav-short" aria-hidden="true">{short}</span>
              </NavLink>
            ))}
          </div>
        ))}
        <button type="button" className="nav-collapse" onClick={toggleNav} aria-label={navCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={navCollapsed ? 'Expand' : 'Collapse'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={navCollapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} /></svg>
        </button>
      </nav>
      <MobileNav main={[NAV_GROUPS[0].items[0], NAV_GROUPS[0].items[1], NAV_GROUPS[1].items[3], NAV_GROUPS[1].items[0]]} more={NAV.flat().filter(([to]) => !['/home', '/', '/deals', '/contacts'].includes(to))} user={user} theme={theme} onToggleTheme={toggleTheme} onSignOut={session.signOut} />
      <main className="main">
        <AppNotices />
        <div className="topbar">
          <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <span>Search deals, people, pages…</span><kbd>Ctrl K</kbd>
          </button>
          <div className="row">
            {(['account', 'prospect'] as const).map((t) => (
              <button key={t} type="button" className="btn topbar-extra" onClick={() => setQuick(t)}>+ {t === 'account' ? 'Company' : 'Contact'}</button>
            ))}
            <button type="button" className="btn btn-primary" onClick={() => setQuick('opportunity')}>+ New deal</button>
          </div>
        </div>
        <div className="page-enter" key={location.pathname}>
        <Routes key={refreshKey}>
          <Route path="/" element={<MyActions />} />
          <Route path="/home" element={<Home />} />
          <Route path="/contacts" element={<Prospects mode="contacts" />} />
          <Route path="/contacts/:id" element={<ProspectRecord />} />
          <Route path="/leads" element={<Prospects mode="leads" />} />
          <Route path="/prospects" element={<Navigate to="/leads" replace />} />
          <Route path="/prospects/:id" element={<ProspectRecord />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/opportunities/:id" element={<OpportunityRecord />} />
          <Route path="/companies" element={<Accounts />} />
          <Route path="/companies/:id" element={<AccountRecord />} />
          <Route path="/accounts" element={<Navigate to="/companies" replace />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/activities" element={<Activities />} />
          <Route path="/forecast" element={<Views />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/data" element={<DataManagement />} />
          <Route path="/accounts/:id" element={<AccountRecord />} />
          <Route path="/views" element={<Navigate to="/forecast" replace />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/import" element={<Navigate to="/data?tab=import" replace />} />
          <Route path="/import/hubspot" element={<Navigate to="/data?tab=hubspot" replace />} />
          <Route path="/cleanup" element={<Navigate to="/data?tab=cleanup" replace />} />
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
