// The signed-in person at the top of the side rail. Clicking opens a small
// menu with who they are, dark mode and sign out.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { DEV_USER } from '../api'
import { Avatar } from '../theme'
import type { User } from '../types'

export default function ProfileMenu({ user, theme, onToggleTheme, onSignOut }: {
  user: User; theme: 'light' | 'dark'; onToggleTheme: () => void; onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  // Beside the avatar on the desktop rail; below it when the rail is a top bar.
  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const below = window.innerWidth <= 720
    const width = 264
    setPos(below
      ? { top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) }
      : { top: r.top, left: r.right + 10 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    menu.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus()
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const dark = theme === 'dark'
  return (
    <>
      <button ref={btn} type="button" className={`profile-btn${open ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={`${user.name}: profile menu`} onClick={() => setOpen((o) => !o)}>
        <Avatar name={user.name} size={42} />
      </button>
      {open && createPortal(
        <div ref={menu} className="profile-menu" role="menu" aria-label="Profile" style={{ top: pos.top, left: pos.left }}>
          <div className="profile-head">
            <Avatar name={user.name} size={40} />
            <div style={{ minWidth: 0 }}>
              <strong className="profile-name">{user.name}</strong>
              <span className="muted small profile-email">{user.email}</span>
              <span className="pill pill-paper" style={{ alignSelf: 'flex-start', marginTop: 4 }}>{user.role_name || user.role}{user.title ? ` · ${user.title}` : ''}{DEV_USER ? ' · dev sign-in' : ''}</span>
            </div>
          </div>
          <div className="profile-sep" />
          <button type="button" role="menuitemcheckbox" aria-checked={dark} className="profile-item" onClick={onToggleTheme}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            <span>Dark mode</span>
            <span className={`switch${dark ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
          <Link to="/settings" role="menuitem" className="profile-item" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
            <span>Settings</span>
          </Link>
          <div className="profile-sep" />
          <button type="button" role="menuitem" className="profile-item danger" onClick={onSignOut}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            <span>Sign out</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
