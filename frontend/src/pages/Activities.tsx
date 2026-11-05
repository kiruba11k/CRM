// Activities & Meetings: every call, email, meeting, note, stage change and
// outcome across the CRM, newest first, filterable by type, owner and date.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { fmtDateTime } from '../format'
import { useSession } from '../session'
import { Avatar } from '../theme'
import { ErrorBanner, SelectField, useLoad } from '../ui'

interface Item {
  id: string; entity_type: 'account' | 'prospect' | 'opportunity'; entity_id: string; kind: string; summary: string; occurred_at: string
  email_direction: 'in' | 'out' | null; outcome: string | null; created_by: string | null; record_name: string | null; account_name: string | null
}
const PATH = { account: '/companies/', prospect: '/contacts/', opportunity: '/opportunities/' }
const RECORD = { account: 'Company', prospect: 'Contact', opportunity: 'Deal' }
const KIND_LABEL: Record<string, string> = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', action_done: 'Action done', status_change: 'Status change',
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
  return (
    <>
      <div className="page-head">
        <div><h1>Activities &amp; Meetings</h1><p>Every logged call, email, meeting, note and change across companies, contacts and deals. Meetings you schedule are on the <Link to="/meetings">Meetings</Link> page.</p></div>
      </div>
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
              <strong>{a.summary}</strong>{a.outcome && <span className="pill pill-amber" style={{ marginLeft: 6 }}>{a.outcome}</span>}
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
