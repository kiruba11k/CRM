// Activity timeline + "log a note/call/meeting" + key-field history.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate, fmtDateTime, nextActionLabel, userName } from '../format'
import { can, useSession } from '../session'
import type { Activity, HistoryEntry, Lists, User } from '../types'
import { ErrorBanner, SelectField, TextField } from '../ui'
import { OUTCOME_LABEL, OUTCOME_TONE } from './CompleteAction'

// Timeline filter: which activity kinds each chip shows.
const FILTERS: { key: string; label: string; kinds: string[] | null }[] = [
  { key: 'all', label: 'All', kinds: null },
  { key: 'notes', label: 'Notes & calls', kinds: ['note', 'call'] },
  { key: 'email', label: 'Emails', kinds: ['email'] },
  { key: 'meeting', label: 'Meetings', kinds: ['meeting'] },
  { key: 'actions', label: 'Actions', kinds: ['action_completed'] },
  { key: 'changes', label: 'Changes', kinds: ['stage_change', 'status_change', 'nurture', 'contact', 'attachment', 'converted', 'merged'] },
]

const FIELD_LABEL: Record<string, string> = {
  stage: 'Stage', owner_id: 'Owner', estimated_value: 'Estimated value', currency: 'Currency', expected_close: 'Expected close',
  risk_rating: 'Risk rating', on_nurture: 'On nurture', nurture_until: 'Nurture until', next_action_code: 'Next action',
  next_action_due: 'Next action due', next_action_time: 'Next action time', next_action_in_calendar: 'In Google Calendar', actual_value: 'Actual value', lost_reason: 'Lost reason', status: 'Status',
  account_id: 'Account', name: 'Name', country: 'Country',
}
type NoteKind = 'note' | 'call' | 'meeting' | 'email'

export function ActivityCard({ activities, postUrl, onAdded }: { activities: Activity[] | undefined; postUrl?: string; onAdded?: () => void }) {
  const [kind, setKind] = useState<NoteKind>('note')
  const [filter, setFilter] = useState('all')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  async function add() {
    if (!summary.trim() || !postUrl) return
    try {
      await api(postUrl, { method: 'POST', body: { kind, summary } })
      setSummary('')
      onAdded?.()
    } catch (e) { setError(e as ApiError) }
  }
  return (
    <section className="card" aria-label="Activity">
      <div className="card-head"><h2>Activity</h2></div>
      {postUrl && <>
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <div className="grid-fields" style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}>
          <SelectField label="Type" value={kind} onChange={(v) => setKind((v as NoteKind) || 'note')}
            options={[{ value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }, { value: 'meeting', label: 'Meeting' }, { value: 'email', label: 'Email' }]} />
          <TextField label="What happened?" value={summary} onChange={setSummary} />
        </div>
        <button type="button" className="btn btn-outline" style={{ alignSelf: 'flex-start' }} onClick={add} disabled={!summary.trim()}>Log activity</button>
      </>}
      <div className="outcome-chips timeline-filter" role="group" aria-label="Show">
        {FILTERS.map((f) => {
          const n = f.kinds ? (activities || []).filter((a) => f.kinds!.includes(a.kind)).length : (activities || []).length
          return <button key={f.key} type="button" className="outcome-chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} <span className="muted">{n}</span></button>
        })}
      </div>
      <div>
        {(activities || []).filter((a) => { const k = FILTERS.find((f) => f.key === filter)?.kinds; return !k || k.includes(a.kind) }).map((a) => (
          <div className="timeline-item" key={a.id}>
            <span className="muted small">{fmtDateTime(a.occurred_at)}</span>
            {a.email_direction ? <AutoEmail a={a} onRemoved={onAdded} /> : (
              <span><strong>{a.outcome ? a.summary.replace(` · ${OUTCOME_LABEL[a.outcome]}`, '') : a.summary}</strong>{a.outcome && <> <span className={`pill pill-${OUTCOME_TONE[a.outcome] || 'grey'}`}>{OUTCOME_LABEL[a.outcome] || a.outcome}</span></>} <span className="muted">· {a.kind.replace('_', ' ')}{a.created_by ? ` · ${a.created_by}` : ''}</span></span>
            )}
          </div>
        ))}
        {(!activities || activities.length === 0) && <p className="muted small">No activity yet.</p>}
      </div>
    </section>
  )
}

// An email logged automatically from someone's Gmail (headers only). Only
// the person whose mailbox it came from can open it in Gmail.
function AutoEmail({ a, onRemoved }: { a: Activity; onRemoved?: () => void }) {
  const { user } = useSession()
  const [busy, setBusy] = useState(false)
  const mine = a.created_by_id === user.id
  const canRemove = mine || can(user, 'edit_all')
  const remove = async () => {
    if (!window.confirm('Remove this email from the CRM? It’s taken off every record and won’t be logged again. Nothing changes in Gmail.')) return
    setBusy(true)
    try { await api(`/gmail/logged/${a.id}`, { method: 'DELETE' }); onRemoved?.() } catch (e) { window.alert((e as ApiError).message) } finally { setBusy(false) }
  }
  return (
    <span>
      <span className={`pill pill-${a.email_direction === 'out' ? 'blue' : 'teal'}`} style={{ marginRight: 6 }}>{a.email_direction === 'out' ? '↗ Sent' : '↙ Received'}</span>
      <strong>{a.summary}</strong>{' '}
      <span className="muted">· auto-logged from {mine ? 'your' : `${a.created_by || 'a colleague'}’s`} Gmail</span>
      {mine && a.gmail_thread_id && <> · <a href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(a.created_by_email || '')}#all/${encodeURIComponent(a.gmail_thread_id)}`} target="_blank" rel="noreferrer">Open in Gmail</a></>}
      {canRemove && <> · <button type="button" className="link-btn" disabled={busy} onClick={() => void remove()}>Remove</button></>}
    </span>
  )
}

// Show history values the way people read them: names, labels, dates.
function readable(field: string, v: string | null, lists: Lists, users: User[]): string {
  if (v === null || v === '') return '—'
  if (field === 'owner_id') return userName(users, v)
  if (field === 'next_action_code') return nextActionLabel(lists, v, '') || v
  if (field === 'on_nurture') return v === 'True' ? 'Yes' : 'No'
  if (/_due$|_close$|_until$|_date$/.test(field)) return fmtDate(v)
  if (field === 'estimated_value' || field === 'actual_value') return Number(v).toLocaleString('en-US')
  return v
}

export function HistoryCard({ history }: { history: HistoryEntry[] | undefined }) {
  const { lists, users } = useSession()
  return (
    <section className="card" aria-label="History">
      <h2>Stage &amp; key-field history</h2>
      <div>
        {(history || []).map((h, i) => (
          <div className="timeline-item" key={i}>
            <span className="muted small">{fmtDateTime(h.changed_at)}</span>
            <span><strong>{FIELD_LABEL[h.field] || h.field}</strong>: {h.old_value === null ? 'set to ' : `${readable(h.field, h.old_value, lists, users)} → `}{readable(h.field, h.new_value, lists, users)} <span className="muted">· {h.changed_by || '—'}</span></span>
          </div>
        ))}
        {(!history || history.length === 0) && <p className="muted small">No changes yet.</p>}
      </div>
    </section>
  )
}
