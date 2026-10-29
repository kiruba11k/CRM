// Activity timeline + "log a note/call/meeting" + key-field history.
import { useState } from 'react'
import { api } from '../api.js'
import { fmtDate, fmtDateTime, nextActionLabel, userName } from '../format.js'
import { useSession } from '../session.jsx'
import { ErrorBanner, SelectField, TextField } from '../ui.jsx'

const FIELD_LABEL = {
  stage: 'Stage', owner_id: 'Owner', estimated_value: 'Estimated value', currency: 'Currency', expected_close: 'Expected close',
  risk_rating: 'Risk rating', on_nurture: 'On nurture', nurture_until: 'Nurture until', next_action_code: 'Next action',
  next_action_due: 'Next action due', actual_value: 'Actual value', lost_reason: 'Lost reason', status: 'Status',
  account_id: 'Account', name: 'Name', country: 'Country',
}

export function ActivityCard({ activities, postUrl, onAdded }) {
  const [kind, setKind] = useState('note')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState(null)
  async function add() {
    if (!summary.trim()) return
    try {
      await api(postUrl, { method: 'POST', body: { kind, summary } })
      setSummary('')
      onAdded()
    } catch (e) { setError(e) }
  }
  return (
    <section className="card" aria-label="Activity">
      <h2>Activity</h2>
      {postUrl && <>
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <div className="grid-fields" style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}>
          <SelectField label="Type" value={kind} onChange={(v) => setKind(v || 'note')}
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
function readable(field, v, lists, users) {
  if (v === null || v === undefined || v === '') return '—'
  if (field === 'owner_id') return userName(users, v)
  if (field === 'next_action_code') return nextActionLabel(lists, v, '') || v
  if (field === 'on_nurture') return v === 'True' ? 'Yes' : 'No'
  if (/_due$|_close$|_until$|_date$/.test(field)) return fmtDate(v)
  if (field === 'estimated_value' || field === 'actual_value') return Number(v).toLocaleString('en-US')
  return v
}

export function HistoryCard({ history }) {
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
