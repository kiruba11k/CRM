// Activity timeline + "log a note/call/meeting" + key-field history.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate, fmtDateTime, nextActionLabel, userName } from '../format'
import { useSession } from '../session'
import type { Activity, HistoryEntry, Lists, User } from '../types'
import { ErrorBanner, SelectField, TextField } from '../ui'

const FIELD_LABEL: Record<string, string> = {
  stage: 'Stage', owner_id: 'Owner', estimated_value: 'Estimated value', currency: 'Currency', expected_close: 'Expected close',
  risk_rating: 'Risk rating', on_nurture: 'On nurture', nurture_until: 'Nurture until', next_action_code: 'Next action',
  next_action_due: 'Next action due', next_action_time: 'Next action time', next_action_in_calendar: 'In Google Calendar', actual_value: 'Actual value', lost_reason: 'Lost reason', status: 'Status',
  account_id: 'Account', name: 'Name', country: 'Country',
}
type NoteKind = 'note' | 'call' | 'meeting' | 'email'

export function ActivityCard({ activities, postUrl, onAdded }: { activities: Activity[] | undefined; postUrl?: string; onAdded?: () => void }) {
  const [kind, setKind] = useState<NoteKind>('note')
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
      <h2>Activity</h2>
      {postUrl && <>
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <div className="grid-fields" style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}>
          <SelectField label="Type" value={kind} onChange={(v) => setKind((v as NoteKind) || 'note')}
            options={[{ value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }, { value: 'meeting', label: 'Meeting' }, { value: 'email', label: 'Email' }]} />
          <TextField label="What happened?" value={summary} onChange={setSummary} />
        </div>
        <button type="button" className="btn btn-outline" style={{ alignSelf: 'flex-start' }} onClick={add} disabled={!summary.trim()}>Log activity</button>
      </>}
      <div>
        {(activities || []).map((a) => (
          <div className="timeline-item" key={a.id}>
            <span className="muted small">{fmtDateTime(a.occurred_at)}</span>
            <span><strong>{a.summary}</strong> <span className="muted">· {a.kind.replace('_', ' ')}{a.created_by ? ` · ${a.created_by}` : ''}</span></span>
          </div>
        ))}
        {(!activities || activities.length === 0) && <p className="muted small">No activity yet.</p>}
      </div>
    </section>
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
