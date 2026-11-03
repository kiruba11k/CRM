// Ctrl/⌘+K command palette: search every deal, prospect and account, jump
// to any page, or start a new record, all from the keyboard.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Account, Opportunity, Prospect } from '../types'
import { StagePill } from '../theme'

export interface PaletteCommand { id: string; group: string; label: string; hint?: string; run: () => void; extra?: ReactNode }

interface Records { opps: Opportunity[]; prospects: Prospect[]; accounts: Account[] }
let cache: { at: number; data: Records } | null = null

async function loadRecords(): Promise<Records> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data
  const [opps, prospects, accounts] = await Promise.all([
    api<Opportunity[]>('/opportunities', { params: { include_nurtured: true } }),
    api<Prospect[]>('/prospects', { params: { scope: 'all' } }),
    api<Account[]>('/accounts'),
  ])
  cache = { at: Date.now(), data: { opps, prospects, accounts } }
  return cache.data
}

const matches = (text: string, q: string) => q.split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w.toLowerCase()))

export default function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: PaletteCommand[] }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [records, setRecords] = useState<Records | null>(null)
  const [loadError, setLoadError] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    window.setTimeout(() => input.current?.focus(), 10)
    loadRecords().then(setRecords).catch(() => setLoadError(true))
  }, [open])

  const items = useMemo<PaletteCommand[]>(() => {
    const go = (path: string) => () => { navigate(path); onClose() }
    const cmd = commands.filter((c) => !q || matches(`${c.label} ${c.group}`, q))
    if (!q || !records) return cmd.slice(0, q ? 8 : 12)
    const deals = records.opps.filter((o) => matches(`${o.name} ${o.account_name || ''} ${o.stage}`, q)).slice(0, 6).map((o) => ({
      id: `o-${o.id}`, group: 'Deals', label: o.name, hint: o.account_name || '', run: go(`/opportunities/${o.id}`), extra: <StagePill stage={o.stage} />,
    }))
    const people = records.prospects.filter((p) => matches(`${p.full_name} ${p.email || ''} ${p.account_name || ''}`, q)).slice(0, 6).map((p) => ({
      id: `p-${p.id}`, group: 'Prospects', label: p.full_name, hint: [p.job_title, p.account_name].filter(Boolean).join(' · '), run: go(`/prospects/${p.id}`),
    }))
    const accs = records.accounts.filter((a) => matches(`${a.name} ${a.industry || ''} ${a.country}`, q)).slice(0, 6).map((a) => ({
      id: `a-${a.id}`, group: 'Accounts', label: a.name, hint: [a.industry, a.country].filter(Boolean).join(' · '), run: go(`/accounts/${a.id}`),
    }))
    return [...deals, ...people, ...accs, ...cmd.slice(0, 6)]
  }, [q, records, commands, navigate, onClose])

  useEffect(() => { setActive(0) }, [q])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  let lastGroup = ''
  return (
    <div className="modal-backdrop palette-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <div className="palette-input">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search deals, prospects, accounts… or type a command"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[active] ? `pal-${items[active].id}` : undefined} aria-label="Search" />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">{loadError ? 'Couldn’t load records; pages and commands still work.' : q && !records ? 'Searching…' : `Nothing matches “${q}”.`}</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            return (
              <div key={it.id}>
                {head && <div className="palette-group">{head}</div>}
                <div id={`pal-${it.id}`} role="option" aria-selected={i === active} className="palette-item"
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); it.run() }}>
                  <span className="palette-label">{it.label}{it.hint && <span className="muted small"> · {it.hint}</span>}</span>
                  {it.extra}
                  {i === active && <kbd aria-hidden="true">↵</kbd>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="palette-foot muted small"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> anytime</span></div>
      </div>
    </div>
  )
}
