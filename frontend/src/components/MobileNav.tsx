// Phones: a bottom tab bar (the four main screens + More). "More" opens a
// sheet with the rest of the CRM, the profile, dark mode, install and sign out.
import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { DEV_USER } from '../api'
import { Avatar } from '../theme'
import type { User } from '../types'
import { InstallHelp, useInstall } from './InstallApp'

type NavItem = [string, string, string, string]

export default function MobileNav({ main, more, user, theme, onToggleTheme, onSignOut }: {
  main: NavItem[]; more: NavItem[]; user: User; theme: 'light' | 'dark'; onToggleTheme: () => void; onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const install = useInstall()
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  const moreActive = more.some(([to]) => location.pathname.startsWith(to))
  const icon = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  return (
    <>
      <nav className="bottom-nav" aria-label="Main">
        {main.map(([to, label, short, d]) => (
          <NavLink key={to} to={to} end={to === '/'} className="bn-link" aria-label={label}>{icon(d)}<span>{short}</span></NavLink>
        ))}
        <button type="button" className={`bn-link${moreActive || open ? ' active' : ''}`} aria-expanded={open} aria-label="More" onClick={() => setOpen((o) => !o)}>
          {icon('M4 6h16M4 12h16M4 18h16')}<span>More</span>
        </button>
      </nav>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="More" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grab" aria-hidden="true" />
            <div className="profile-head">
              <Avatar name={user.name} size={42} />
              <div style={{ minWidth: 0 }}>
                <strong className="profile-name">{user.name}</strong>
                <span className="muted small profile-email">{user.email}</span>
                <span className="pill pill-paper" style={{ alignSelf: 'flex-start', marginTop: 4 }}>{user.role_name || user.role}{DEV_USER ? ' · dev sign-in' : ''}</span>
              </div>
            </div>
            <div className="sheet-grid">
              {more.map(([to, label, , d]) => (
                <NavLink key={to} to={to} className="sheet-tile">{icon(d)}<span>{label}</span></NavLink>
              ))}
            </div>
            <div className="profile-sep" />
            {install.show && (
              <button type="button" className="profile-item" onClick={() => void install.start()}>
                {icon('M12 3v12M7 10l5 5 5-5M5 21h14')}<span>Install the app</span>
              </button>
            )}
            <button type="button" role="menuitemcheckbox" aria-checked={theme === 'dark'} className="profile-item" onClick={onToggleTheme}>
              {icon('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z')}<span>Dark mode</span><span className={`switch${theme === 'dark' ? ' on' : ''}`} aria-hidden="true"><span /></span>
            </button>
            <button type="button" className="profile-item danger" onClick={onSignOut}>
              {icon('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9')}<span>Sign out</span>
            </button>
          </div>
        </div>
      )}
      {install.help && <InstallHelp ios={install.ios} onClose={install.closeHelp} />}
    </>
  )
}
