// Meeting bits shared by the Meetings page and record pages.
import { Link } from 'react-router-dom'
import { api } from '../api'
import { fmtDateTime } from '../format'
import type { Meeting, SyncState } from '../types'
import { useLoad } from '../ui'

const SYNC: Record<SyncState, { label: string; pill: string }> = {
  synced: { label: 'In Google Calendar', pill: 'teal' },
  pending: { label: 'Syncing…', pill: 'blue' },
  failed: { label: 'Sync failed', pill: 'red' },
  not_connected: { label: 'Not in Google Calendar', pill: 'amber' },
  cancelled: { label: 'Cancelled', pill: 'grey' },
}

export const SyncPill = ({ state }: { state: SyncState }) => <span className={`pill pill-${SYNC[state].pill}`}>{SYNC[state].label}</span>

export function MeetingsCard({ entityType, entityId }: { entityType: 'prospect' | 'opportunity'; entityId: string }) {
  const { data } = useLoad(() => api<Meeting[]>('/meetings', { params: { entity_type: entityType, entity_id: entityId } }), [entityType, entityId])
  return (
    <section className="card" aria-label="Meetings">
      <div className="card-head">
        <h2>Meetings</h2>
        <Link className="small" to={`/meetings?record=${entityType}:${entityId}`}>+ Schedule</Link>
      </div>
      {(data || []).length === 0 && <p className="muted small" style={{ margin: 0 }}>No upcoming meetings.</p>}
      {(data || []).map((m) => (
        <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong>{m.title}</strong>
          <span className="small muted">{fmtDateTime(m.starts_at)} · {m.owner_name}</span>
          <span className="row" style={{ gap: 8 }}>
            <SyncPill state={m.sync_status} />
            {m.meet_url && <a className="small" href={m.meet_url} target="_blank" rel="noreferrer">Join Meet</a>}
          </span>
        </div>
      ))}
    </section>
  )
}
