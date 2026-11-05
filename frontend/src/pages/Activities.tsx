// Activities & Meetings: every call, email, meeting, note, stage change and
// outcome across the CRM, newest first, filterable by type, owner and date.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { fmtDateTime } from '../format'
import { useSession } from '../session'
import { Avatar } from '../theme'
import { ErrorBanner, Segmented, SelectField, useLoad } from '../ui'
import type { Meeting } from '../types'
import { OUTCOME_LABEL, OUTCOME_TONE } from '../components/CompleteAction'

interface Item {
  id: string; entity_type: 'account' | 'prospect' | 'opportunity'; entity_id: string; kind: string; summary: string; occurred_at: string
  email_direction: 'in' | 'out' | null; outcome: string | null; created_by: string | null; record_name: string | null; account_name: string | null
}
const PATH = { account: '/companies/', prospect: '/contacts/', opportunity: '/opportunities/' }
const RECORD = { account: 'Company', prospect: 'Contact', opportunity: 'Deal' }
const KIND_LABEL: Record<string, string> = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', action_completed: 'Action done', status_change: 'Status change', automation: 'Automation', contact: 'Deal contact', merged: 'Merge',
  stage_change: 'Stage change', nurture: 'Nurture', converted: 'Converted', attachment: 'File', merge: 'Merge', rescheduled: 'Rescheduled' }
const RANGES = [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]

export default function Activities() {
  const { users } = useSession()
  const [kind, setKind] = useState<string | null>(null)
  const [owner, setOwner] = useState<string | null>(null)
  const [range, setRange] = useState<string | null>('30')
  const [type, setType] = useState<string | null>(null)
  const since = range ? new Date(Date.now() - Number(range) * 86400000).toISOString().slice(0, 10) : undefined
  const data = useLoad(() => api<{ kinds: string[]; items: Item[] }>('/activities', { params: { kind, owner, since, entity_type: type, limit: 300 } }), [kind, owner, since, type])
  const items = data.data?.items || []
  const [meetScope, setMeetScope] = useState<'mine' | 'all'>('mine')
  const meetings = useLoad(() => api<Meeting[]>('/meetings', { params: { scope: meetScope, upcoming: true } }), [meetScope])
  return (
    <>
      <div className="page-head">
        <div><h1>Activities &amp; Meetings</h1><p>Meetings coming up, and every logged call, email, meeting, note and change across companies, contacts and deals.</p></div>
      </div>
      <section className="card" aria-label="Upcoming meetings">
        <div className="card-head">
          <h2>Upcoming meetings <span className="muted" style={{ fontWeight: 500 }}>· {(meetings.data || []).length}</span></h2>
          <div className="row">
            <Segmented<'mine' | 'all'> label="Whose meetings" value={meetScope} onChange={setMeetScope} options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone' }]} />
            <Link className="btn btn-outline" to="/meetings">Schedule</Link>
          </div>
        </div>
        <ErrorBanner error={meetings.error} />
        {meetings.data && meetings.data.length === 0 && <p className="muted small" style={{ margin: 0 }}>No meetings coming up.</p>}
        {(meetings.data || []).slice(0, 8).map((m) => (
          <div className="activity-row" key={m.id}>
            <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(m.starts_at)}</span>
            <span className={`pill pill-${m.kind === 'follow_up' ? 'blue' : 'purple'}`}>{m.kind === 'follow_up' ? 'Follow-up' : 'Meeting'}</span>
            <span style={{ flex: 1, minWidth: 0 }}><strong>{m.title}</strong>
              {m.entity_type && m.entity_id && <> · <Link to={`${PATH[m.entity_type]}${m.entity_id}`}>{m.entity_name || 'record'}</Link></>}
              {meetScope === 'all' && <span className="muted"> · {m.owner_name}</span>}</span>
            {m.meet_url && <a className="small" href={m.meet_url} target="_blank" rel="noreferrer">Join</a>}
          </div>
        ))}
        {(meetings.data || []).length > 8 && <Link className="small" to="/meetings">and {(meetings.data || []).length - 8} more on the Meetings page</Link>}
      </section>
      <h2 style={{ margin: '4px 0 0', fontSize: 18 }}>Activity log</h2>
      <div className="grid-fields" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        <SelectField label="Type" value={kind} onChange={setKind} placeholder="All types" options={(data.data?.kinds || []).map((k) => ({ value: k, label: KIND_LABEL[k] || k }))} />
        <SelectField label="Logged by" value={owner} onChange={setOwner} placeholder="Everyone" options={users.map((u) => ({ value: u.id, label: u.name }))} />
        <SelectField label="When" value={range} onChange={setRange} placeholder="Any time" options={RANGES} />
        <SelectField label="Record" value={type} onChange={setType} placeholder="All records" options={[{ value: 'opportunity', label: 'Deals' }, { value: 'prospect', label: 'Contacts' }, { value: 'account', label: 'Companies' }]} />
      </div>
      <ErrorBanner error={data.error} />
      <section className="card" aria-label="Activity list">
        {data.loading && !data.data && <div className="loading" data-label="Loading…">Loading…</div>}
        {data.data && items.length === 0 && <div className="empty">No activity matches.</div>}
        {items.map((a) => (
          <div className="activity-row" key={a.id}>
            <span className={`pill pill-${a.kind === 'email' ? 'blue' : a.kind === 'call' ? 'teal' : a.kind === 'meeting' ? 'purple' : 'paper'}`}>{KIND_LABEL[a.kind] || a.kind}{a.email_direction ? (a.email_direction === 'out' ? ' ↗' : ' ↙') : ''}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>{a.outcome ? a.summary.replace(` · ${OUTCOME_LABEL[a.outcome]}`, '') : a.summary}</strong>{a.outcome && <span className={`pill pill-${OUTCOME_TONE[a.outcome] || 'grey'}`} style={{ marginLeft: 6 }}>{OUTCOME_LABEL[a.outcome] || a.outcome}</span>}
              <div className="muted small">{RECORD[a.entity_type]}: <Link to={PATH[a.entity_type] + a.entity_id}>{a.record_name || 'record'}</Link>{a.account_name && a.entity_type !== 'account' ? ` · ${a.account_name}` : ''}</div>
            </div>
            <span className="muted small activity-meta">{a.created_by && <><Avatar name={a.created_by} size={20} /> {a.created_by} · </>}{fmtDateTime(a.occurred_at)}</span>
          </div>
        ))}
        {items.length >= 300 && <span className="muted small">Showing the latest 300. Narrow the filters to see older activity.</span>}
      </section>
    </>
  )
}
