// Bulk actions on record tables: tick rows, then change owner, status/stage,
// risk or next action for all of them. The server applies each record's
// normal rules and reports any it had to skip.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ApiError, api } from '../api'
import { can, useSession } from '../session'
import type { FormValues } from '../types'
import { ErrorBanner, NextActionFields, OwnerField, SelectField } from '../ui'
import { useToast } from './Toast'

export type BulkEntity = 'accounts' | 'prospects' | 'opportunities'
type Action = 'owner' | 'status' | 'stage' | 'risk' | 'next'
interface BulkResult { requested: number; updated: number; failed: { id: string; name: string | null; message: string }[] }

const NOUN: Record<BulkEntity, [string, string]> = { accounts: ['account', 'accounts'], prospects: ['prospect', 'prospects'], opportunities: ['deal', 'deals'] }
const ACTIONS: Record<BulkEntity, Action[]> = { accounts: ['owner', 'status'], prospects: ['owner', 'status', 'next'], opportunities: ['owner', 'stage', 'risk', 'next'] }
const LABEL: Record<Action, string> = { owner: 'Assign owner', status: 'Change status', stage: 'Move stage', risk: 'Set risk', next: 'Set next action' }

/** Selection that only ever counts rows currently shown. */
export function useSelection(visibleIds: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const selected = useMemo(() => visibleIds.filter((id) => picked.has(id)), [visibleIds, picked])
  const all = visibleIds.length > 0 && selected.length === visibleIds.length
  return {
    selected,
    has: (id: string) => picked.has(id),
    toggle: (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }),
    toggleAll: () => setPicked(all ? new Set() : new Set(visibleIds)),
    clear: () => setPicked(new Set()),
    all, some: selected.length > 0 && !all,
  }
}
export type Selection = ReturnType<typeof useSelection>

export function SelectAllBox({ sel, label }: { sel: Selection; label: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = sel.some }, [sel.some])
  return (
    <th className="sel-col">
      <input ref={ref} type="checkbox" className="sel-box" aria-label={`Select all ${label}`} checked={sel.all} onChange={sel.toggleAll} />
    </th>
  )
}

export function RowBox({ sel, id, label }: { sel: Selection; id: string; label: string }) {
  return (
    <td className="sel-col" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" className="sel-box" aria-label={`Select ${label}`} checked={sel.has(id)} onChange={() => sel.toggle(id)} />
    </td>
  )
}

export function BulkBar({ entity, sel, onDone }: { entity: BulkEntity; sel: Selection; onDone: () => void }) {
  const { user, lists } = useSession()
  const toast = useToast()
  const [action, setAction] = useState<Action | null>(null)
  const [form, setForm] = useState<FormValues>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [result, setResult] = useState<BulkResult | null>(null)
  const n = sel.selected.length
  const [one, many] = NOUN[entity]
  const actions = ACTIONS[entity].filter((a) => a !== 'owner' || can(user, 'edit_all'))

  useEffect(() => { if (n === 0) { setAction(null); setError(null) } }, [n])
  const open = (a: Action) => { setAction(action === a ? null : a); setForm({}); setError(null) }

  const changes = (): FormValues | null => {
    if (action === 'owner') return form.owner_id ? { owner_id: form.owner_id } : null
    if (action === 'status') return form.status ? { status: form.status } : null
    if (action === 'stage') return form.stage ? { stage: form.stage } : null
    if (action === 'risk') return form.risk_rating ? { risk_rating: form.risk_rating } : null
    if (action === 'next') return form.next_action_code && form.next_action_due
      ? { next_action_code: form.next_action_code, next_action_other: form.next_action_other || null, next_action_due: form.next_action_due } : null
    return null
  }
  const apply = async () => {
    const c = changes()
    if (!c) return
    setBusy(true); setError(null)
    try {
      const r = await api<BulkResult>(`/bulk/${entity}`, { method: 'POST', body: { ids: sel.selected, changes: c } })
      if (r.updated) toast(`Updated ${r.updated} ${r.updated === 1 ? one : many}.${r.failed.length ? ` ${r.failed.length} skipped.` : ''}`)
      setResult(r.failed.length ? r : null)
      setAction(null)
      sel.clear()
      onDone()
    } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
  }

  return (
    <>
      {result && (
        <div className="banner banner-warn bulk-result" role="status">
          <div>
            <strong>{result.updated} of {result.requested} updated. These were skipped:</strong>
            <ul>{result.failed.slice(0, 20).map((f) => <li key={f.id}><strong>{f.name || 'Unknown record'}</strong>: {f.message}</li>)}</ul>
            {result.failed.length > 20 && <span className="small">and {result.failed.length - 20} more.</span>}
          </div>
          <button type="button" className="btn" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}
      <AnimatePresence>
        {n > 0 && (
          <div className="bulk-dock">
          <motion.div className="bulk-bar" role="region" aria-label="Bulk actions"
            initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ duration: 0.18 }}>
            {action && (
              <div className="bulk-panel">
                <ErrorBanner error={error} onClose={() => setError(null)} />
                <div className="grid-fields">
                  {action === 'owner' && <OwnerField label="New owner" value={form.owner_id} onChange={(v) => setForm({ owner_id: v })} />}
                  {action === 'status' && <SelectField label="New status" required value={form.status} onChange={(v) => setForm({ status: v })} placeholder="Choose…"
                    options={entity === 'accounts' ? lists.account_statuses : lists.prospect_statuses} />}
                  {action === 'stage' && <SelectField label="New stage" required value={form.stage} onChange={(v) => setForm({ stage: v })} placeholder="Choose…"
                    options={lists.stages.map((s) => s.name)} />}
                  {action === 'risk' && <SelectField label="Risk rating" required value={form.risk_rating} onChange={(v) => setForm({ risk_rating: v })} placeholder="Choose…"
                    options={lists.risk_ratings} />}
                  {action === 'next' && <NextActionFields value={form} onChange={setForm} />}
                </div>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <button type="button" className="btn btn-dark" disabled={busy || !changes()} onClick={() => void apply()}>
                    {busy ? 'Saving…' : `Apply to ${n} ${n === 1 ? one : many}`}
                  </button>
                  <button type="button" className="btn" onClick={() => setAction(null)}>Cancel</button>
                  <span className="muted small">
                    {action === 'stage' ? 'Each deal must meet the new stage’s rules (e.g. value and risk from Qualified); any that don’t are listed.'
                      : action === 'status' && entity === 'prospects' ? 'Disqualified prospects lose their next action.'
                      : 'Each record’s usual rules and change history apply.'}
                  </span>
                </div>
              </div>
            )}
            <div className="bulk-main">
              <span className="bulk-count"><strong>{n}</strong> {n === 1 ? one : many} selected</span>
              <span className="bulk-actions">
                {actions.map((a) => (
                  <button key={a} type="button" className={`btn${action === a ? ' btn-dark' : ''}`} aria-pressed={action === a} onClick={() => open(a)}>{LABEL[a]}</button>
                ))}
              </span>
              <button type="button" className="btn bulk-clear" onClick={sel.clear}>Clear</button>
            </div>
          </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
