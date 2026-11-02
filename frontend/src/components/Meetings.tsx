// Meeting bits shared by the Meetings page and record pages.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { fmtDateTime } from '../format'
import type { FollowUp, Meeting, SyncState, TaskLink, TaskSyncState } from '../types'
import { ErrorBanner, useLoad } from '../ui'

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
          <span className="small muted">{m.kind === 'follow_up' ? 'Follow-up · ' : ''}{fmtDateTime(m.starts_at)} · {m.owner_name}</span>
          <span className="row" style={{ gap: 8 }}>
            <SyncPill state={m.sync_status} />
            {m.meet_url && <a className="small" href={m.meet_url} target="_blank" rel="noreferrer">Join Meet</a>}
          </span>
        </div>
      ))}
    </section>
  )
}

// The calendar event behind a next action with a time (§6.1): its sync
// state, the Google link once confirmed, and a retry when it failed.
export function FollowUpStatus({ followUp, onChange }: { followUp: FollowUp | null; onChange: () => void }) {
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  if (!followUp) return null
  const retry = () => {
    setBusy(true)
    api(`/meetings/${followUp.id}/retry`, { method: 'POST' }).then(onChange).catch((e: ApiError) => setError(e)).finally(() => setBusy(false))
  }
  return (
    <div className="row" style={{ gap: 8 }} aria-label="Calendar follow-up">
      <SyncPill state={followUp.sync_status} />
      <span className="small muted">{followUp.title} · {fmtDateTime(followUp.starts_at)}</span>
      {followUp.html_link && <a className="small" href={followUp.html_link} target="_blank" rel="noreferrer">Open in Calendar</a>}
      {['failed', 'not_connected', 'pending'].includes(followUp.sync_status) && (
        <button type="button" className="btn btn-outline" disabled={busy} onClick={retry}>Retry sync</button>
      )}
      {followUp.sync_error && <span className="small" style={{ color: 'var(--red-ink)', flexBasis: '100%' }}>{followUp.sync_error}</span>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
    </div>
  )
}

const TASK: Record<TaskSyncState, { label: string; pill: string }> = {
  synced: { label: 'In Google Tasks', pill: 'teal' },
  pending: { label: 'Syncing to Tasks…', pill: 'blue' },
  failed: { label: 'Tasks sync failed', pill: 'red' },
  not_connected: { label: 'Not in Google Tasks', pill: 'amber' },
  completed: { label: 'Ticked off in Tasks', pill: 'grey' },
  removed: { label: 'Removed from Tasks', pill: 'grey' },
}

// The Google Tasks to-do mirroring this record's next action (§6.3, one-way).
export function TaskStatus({ task, onChange }: { task: TaskLink | null; onChange: () => void }) {
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  if (!task) return null
  const retry = () => {
    setBusy(true)
    api(`/tasks/links/${task.id}/retry`, { method: 'POST' }).then(onChange).catch((e: ApiError) => setError(e)).finally(() => setBusy(false))
  }
  return (
    <div className="row" style={{ gap: 8 }} aria-label="Google Tasks">
      <span className={`pill pill-${TASK[task.sync_status].pill}`}>{TASK[task.sync_status].label}</span>
      <span className="small muted">{task.title}</span>
      {['failed', 'not_connected', 'pending'].includes(task.sync_status) && (
        <button type="button" className="btn btn-outline" disabled={busy} onClick={retry}>Retry sync</button>
      )}
      {task.sync_error && <span className="small" style={{ color: 'var(--red-ink)', flexBasis: '100%' }}>{task.sync_error}</span>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
    </div>
  )
}
