// Colour system and small visual building blocks shared across screens:
// one colour per sales stage (used everywhere a stage shows), a stable
// colour per person for avatars, light/dark theme switching, and sortable
// table headers.
import { useEffect, useMemo, useState, type ReactNode } from 'react'

export const STAGE_COLOR: Record<string, string> = {
  'Lead identified': '#94A3B8', Qualified: '#3B82F6', 'Discovery / scoping': '#06B6D4', 'Solution design': '#F59E0B',
  'Proposal submitted': '#F97316', Negotiation: '#A855F7', 'Verbal commitment': '#6366F1', Won: '#16A34A', Lost: '#E11D48',
}
export const stageColor = (stage: string) => STAGE_COLOR[stage] || '#94A3B8'

export function StagePill({ stage, probability }: { stage: string; probability?: number }) {
  const c = stageColor(stage)
  return (
    <span className="pill stage-pill" style={{ ['--stage' as string]: c }}>
      <span className="stage-dot" style={{ background: c }} />{stage}{probability !== undefined ? ` · ${probability}%` : ''}
    </span>
  )
}

// Avatar colours: soft tint + strong ink, picked by hashing the name so a
// person always gets the same colour.
const AVATAR = [
  ['#E0E7FF', '#3730A3'], ['#DCFCE7', '#166534'], ['#FEF3C7', '#92400E'], ['#FCE7F3', '#9D174D'],
  ['#CFFAFE', '#155E75'], ['#EDE9FE', '#5B21B6'], ['#FFE4E6', '#9F1239'], ['#E0F2FE', '#075985'],
]
export const initials = (name: string | null | undefined) =>
  (name || '?').replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'

export function Avatar({ name, size = 28 }: { name: string | null | undefined; size?: number }) {
  const [bg, ink] = AVATAR[[...(name || '?')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR.length]
  return (
    <span className="avatar" data-tip={name || 'Unassigned'} aria-label={name || 'Unassigned'}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)), background: bg, color: ink }}>
      {initials(name)}
    </span>
  )
}

// ── Light / dark theme ───────────────────────────────────────────────
type Theme = 'light' | 'dark'
const KEY = 'ls-crm-theme'

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem(KEY) as Theme | null) || systemTheme() } catch { return systemTheme() }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0F1117' : '#F4F5FA')
  }, [theme])
  const toggle = () => setTheme((t) => {
    const next = t === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(KEY, next) } catch { /* private mode */ }
    return next
  })
  return [theme, toggle]
}

// ── Sortable tables ──────────────────────────────────────────────────
export type SortDir = 'asc' | 'desc'
export function useSort<T>(rows: T[], initial: { key: string; dir: SortDir }, getters: Record<string, (r: T) => string | number | null | undefined>) {
  const [sort, setSort] = useState(initial)
  const sorted = useMemo(() => {
    const get = getters[sort.key]
    if (!get) return rows
    const mul = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * mul
    })
  }, [rows, sort, getters])
  const by = (key: string) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))
  return { sorted, sort, by }
}

export function SortTh({ label, k, sort, by, num }: { label: ReactNode; k: string; sort: { key: string; dir: SortDir }; by: (k: string) => void; num?: boolean }) {
  const active = sort.key === k
  return (
    <th className={num ? 'num' : undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sort-btn${active ? ' active' : ''}`} onClick={() => by(k)}>
        {label}<span className={`sort-arrow${active && sort.dir === 'desc' ? ' down' : ''}`} aria-hidden="true">▲</span>
      </button>
    </th>
  )
}
