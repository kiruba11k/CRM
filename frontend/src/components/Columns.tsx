// Configurable table columns: a "Columns" button with a tick list. The choice
// is remembered per table on this device and can be saved in a view.
import { useEffect, useRef, useState } from 'react'

export interface ColumnDef { key: string; label: string; default?: boolean; locked?: boolean }

export function useColumns(table: string, all: ColumnDef[]) {
  const storeKey = `ls-crm-cols-${table}`
  const defaults = all.filter((c) => c.default !== false).map((c) => c.key)
  const [shown, setShown] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(storeKey) || 'null'); if (Array.isArray(v)) return v } catch { /* private mode */ }
    return defaults
  })
  const set = (cols: string[]) => {
    const next = all.filter((c) => c.locked || cols.includes(c.key)).map((c) => c.key)
    setShown(next)
    try { localStorage.setItem(storeKey, JSON.stringify(next)) } catch { /* private mode */ }
  }
  return { shown, has: (k: string) => shown.includes(k), set, reset: () => set(defaults), all }
}
export type Columns = ReturnType<typeof useColumns>

export function ColumnPicker({ cols }: { cols: Columns }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="col-picker" ref={ref}>
      <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 4h6v16H4zM14 4h6v16h-6z" /></svg> Columns
      </button>
      {open && (
        <div className="col-menu" role="group" aria-label="Choose columns">
          {cols.all.map((c) => (
            <label key={c.key} className="check small">
              <input type="checkbox" disabled={c.locked} checked={cols.has(c.key)}
                onChange={(e) => cols.set(e.target.checked ? [...cols.shown, c.key] : cols.shown.filter((k) => k !== c.key))} /> {c.label}
            </label>
          ))}
          <button type="button" className="link-btn small" onClick={cols.reset}>Reset to default</button>
        </div>
      )}
    </div>
  )
}
