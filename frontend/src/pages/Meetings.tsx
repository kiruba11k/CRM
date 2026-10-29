// §6 Meetings & booking links. Meetings are saved in the CRM, then created
// in the owner's own Google Calendar with a Meet link; the stored event ID
// means updates change that event instead of adding another, and every
// sync failure stays visible with a retry. Until the server is set up for
// Calendar sync, scheduling falls back to a pre-filled Google Calendar tab.
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { fmtDateTime } from '../format'
import { useSession } from '../session'
import { SyncPill } from '../components/Meetings'
import type { BookingLink, CalendarStatus, CalendarSyncStatus, Meeting, Opportunity, Prospect } from '../types'
import { Banner, ErrorBanner, SelectField, Tabs, TextField, useLoad } from '../ui'

type Tab = 'schedule' | 'booking' | 'sync'
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
const PATH = { account: '/accounts/', prospect: '/prospects/', opportunity: '/opportunities/' } as const

// "2026-10-29T14:30" + minutes → Google's local "20261029T143000" form.
function calStamp(local: string, addMinutes = 0): string {
  const d = new Date(local)
  d.setMinutes(d.getMinutes() + addMinutes)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`
}

function calendarUrl(f: { title: string; when: string; minutes: number; attendees: string[] }): string {
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: f.title, dates: `${calStamp(f.when)}/${calStamp(f.when, f.minutes)}`, ctz: tz,
    details: 'Scheduled from LeadStrategus CRM.', add: f.attendees.join(','),
  })
  return `https://calendar.google.com/calendar/render?${q.toString()}`
}

const splitEmails = (s: string) => s.split(/[\s,;]+/).filter(Boolean)

function ConnectionBar({ status, onChange }: { status: CalendarStatus; onChange: () => void }) {
  const [error, setError] = useState<ApiError | null>(null)
  const connect = () => api<{ url: string }>('/calendar/connect', { method: 'POST' }).then((r) => { window.location.href = r.url }).catch((e: ApiError) => setError(e))
  const disconnect = () => api('/calendar/disconnect', { method: 'POST' }).then(onChange).catch((e: ApiError) => setError(e))
  const c = status.connection
  return (
    <>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {!status.configured ? (
        <Banner kind="warn">Direct Google Calendar sync isn’t set up on the server yet (missing {status.missing.join(', ')}). Meetings open as a pre-filled Google Calendar event instead.</Banner>
      ) : status.connected && c ? (
        <div className="banner banner-ok" role="status">
          <div>Google Calendar connected for {c.google_email}{c.last_sync_at ? ` · last sync ${fmtDateTime(c.last_sync_at)}` : ''}.</div>
          <button type="button" className="btn" onClick={() => void disconnect()}>Disconnect</button>
        </div>
      ) : (
        <div className="banner banner-warn" role="status">
          <div>{c?.status === 'needs_reconnect' ? `Google Calendar access expired: ${c.last_error || 'reconnect to keep syncing.'}` : 'Connect your Google Calendar so meetings you schedule here appear there, with a Meet link.'}</div>
          <button type="button" className="btn btn-dark" onClick={() => void connect()}>{c ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}</button>
        </div>
      )}
    </>
  )
}

function MeetingRow({ m, onChange }: { m: Meeting; onChange: () => void }) {
  const { user } = useSession()
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const mine = m.owner_id === user.id || user.role !== 'salesperson'
  const act = (path: string) => {
    setBusy(true)
    api(`/meetings/${m.id}/${path}`, { method: 'POST' }).then(onChange).catch((e: ApiError) => setError(e)).finally(() => setBusy(false))
  }
  return (
    <div className="list-row">
      <span style={{ flex: '1 1 320px', minWidth: 0 }}>
        <strong>{m.title}</strong><br />
        <span className="muted small">{fmtDateTime(m.starts_at)} · {m.time_zone}{m.entity_type && m.entity_id ? <> · <Link to={PATH[m.entity_type] + m.entity_id}>{m.entity_name}</Link></> : ''}{m.attendees.length ? ` · ${m.attendees.join(', ')}` : ''}</span>
        {m.sync_error && <><br /><span className="small" style={{ color: 'var(--red-ink)' }}>{m.sync_error}</span></>}
        <ErrorBanner error={error} onClose={() => setError(null)} />
      </span>
      <span className="row">
        <SyncPill state={m.sync_status} />
        {m.meet_url && <a className="btn btn-outline" href={m.meet_url} target="_blank" rel="noreferrer">Join Meet</a>}
        {m.html_link && <a className="btn" href={m.html_link} target="_blank" rel="noreferrer">Open in Calendar</a>}
        {mine && ['failed', 'not_connected', 'pending'].includes(m.sync_status) && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => act('retry')}>Retry sync</button>}
        {mine && <button type="button" className="btn" disabled={busy} onClick={() => act('cancel')}>Cancel</button>}
      </span>
    </div>
  )
}

function ScheduleTab({ status, reloadStatus }: { status: CalendarStatus; reloadStatus: () => void }) {
  const { lists } = useSession()
  const [params] = useSearchParams()
  const opps = useLoad(() => api<Opportunity[]>('/opportunities', { params: { open_only: true, include_nurtured: true } }), [])
  const prospects = useLoad(() => api<Prospect[]>('/prospects', { params: { scope: 'all' } }), [])
  const upcoming = useLoad(() => api<Meeting[]>('/meetings', { params: { scope: 'mine' } }), [])
  const [record, setRecord] = useState<string | null>(params.get('record'))
  const [title, setTitle] = useState('')
  const [attendees, setAttendees] = useState('')
  const [when, setWhen] = useState('')
  const [minutes, setMinutes] = useState<string | null>('30')
  const [meet, setMeet] = useState(true)
  const [r15, setR15] = useState(lists.reminders.meeting_15)
  const [rDay, setRDay] = useState(lists.reminders.meeting_day)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [result, setResult] = useState<Meeting | null>(null)
  const [saving, setSaving] = useState(false)
  const direct = status.configured

  const options = [
    ...(opps.data || []).map((o) => ({ value: `opportunity:${o.id}`, label: `Opportunity · ${o.account_name} · ${o.name}` })),
    ...(prospects.data || []).filter((p) => p.status !== 'Disqualified').map((p) => ({ value: `prospect:${p.id}`, label: `Prospect · ${p.full_name}${p.account_name ? ` (${p.account_name})` : ''}` })),
  ]

  function prefill(v: string | null) {
    if (!v) return
    const [kind, id] = v.split(':')
    if (kind === 'prospect') {
      const p = prospects.data?.find((x) => x.id === id)
      if (p?.email && !attendees) setAttendees(p.email)
      if (p && !title) setTitle(`LeadStrategus × ${p.account_name || p.full_name}`)
    } else {
      const o = opps.data?.find((x) => x.id === id)
      if (o && !title) setTitle(`LeadStrategus × ${o.account_name}: ${o.name}`)
    }
  }
  // A record passed in the link (from a record page) prefills once loaded.
  useEffect(() => { prefill(record) }, [opps.data, prospects.data]) // eslint-disable-line react-hooks/exhaustive-deps

  async function schedule() {
    setError(null)
    setResult(null)
    if (!title.trim() || !when) { setError(new Error('Add a title and a date & time.')); return }
    const [entity_type, entity_id] = record ? record.split(':') : [null, null]
    if (!direct) {
      window.open(calendarUrl({ title, when, minutes: Number(minutes || 30), attendees: splitEmails(attendees) }), '_blank', 'noopener')
    }
    setSaving(true)
    try {
      const m = await api<Meeting>('/meetings', {
        method: 'POST',
        body: { entity_type, entity_id, title, starts_at: new Date(when).toISOString(), duration_minutes: Number(minutes || 30), time_zone: tz,
          attendees: splitEmails(attendees), add_meet: meet, reminder_15: r15, reminder_day: rDay },
      })
      setResult(m)
      void upcoming.reload()
      reloadStatus()
    } catch (e) { setError(e as ApiError) } finally { setSaving(false) }
  }

  return (
    <div className="cols">
      <div className="col-main">
        <section className="card strong" aria-label="Schedule from the CRM">
          <h2>Schedule from the CRM</h2>
          <ErrorBanner error={opps.error || prospects.error || error} onClose={() => setError(null)} />
          {result && (result.sync_status === 'synced'
            ? <Banner onClose={() => setResult(null)}>Created in Google Calendar{result.meet_url ? ' with a Meet link' : ''}; invites sent to attendees. {result.meet_url && <a href={result.meet_url} target="_blank" rel="noreferrer">Join link</a>}</Banner>
            : <Banner kind={direct ? 'err' : 'warn'} onClose={() => setResult(null)}>
                {direct ? `Saved in the CRM, but not in Google Calendar: ${result.sync_error || 'sync failed.'} Nothing was dropped; use Retry sync below.`
                  : 'Logged on the record. Save the event in the Google Calendar tab that opened.'}
              </Banner>)}
          <div className="grid-fields">
            <SelectField label="Linked record" value={record} onChange={(v) => { setRecord(v); prefill(v) }} options={options} placeholder="Not linked" />
            <TextField label="Title" required value={title} onChange={setTitle} />
            <TextField label="Attendees" value={attendees} onChange={setAttendees} placeholder="name@company.com, …" hint="Separate emails with commas" />
            <div className="field">
              <label htmlFor="meeting-when">Date &amp; time <span className="req" aria-hidden="true">*</span></label>
              <input id="meeting-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <span className="hint">Your time zone: {tz}</span>
            </div>
            <SelectField label="Duration" value={minutes} onChange={setMinutes} options={[{ value: '15', label: '15 minutes' }, { value: '30', label: '30 minutes' }, { value: '45', label: '45 minutes' }, { value: '60', label: '1 hour' }, { value: '90', label: '1.5 hours' }]} />
          </div>
          {direct && (
            <div className="row">
              <label className="check"><input type="checkbox" checked={meet} onChange={(e) => setMeet(e.target.checked)} /> Add Google Meet link</label>
              <label className="check"><input type="checkbox" checked={r15} onChange={(e) => setR15(e.target.checked)} /> 15-minute reminder</label>
              <label className="check"><input type="checkbox" checked={rDay} onChange={(e) => setRDay(e.target.checked)} /> Day-before reminder</label>
            </div>
          )}
          <div className="row">
            <button type="button" className="btn btn-dark" disabled={saving} onClick={() => void schedule()}>
              {saving ? 'Saving…' : direct ? (status.connected ? 'Create in Google Calendar' : 'Save meeting') : 'Open in Google Calendar'}
            </button>
            {direct && !status.connected && <span className="muted small">Not connected yet: the meeting is saved and syncs as soon as you connect.</span>}
            {!direct && <span className="muted small">In Calendar, click “Add Google Meet video conferencing”.</span>}
          </div>
        </section>
        <section className="card" aria-label="Your upcoming meetings">
          <h2>Your upcoming meetings</h2>
          <ErrorBanner error={upcoming.error} />
          {(upcoming.data || []).length === 0 && <p className="muted" style={{ margin: 0 }}>None scheduled.</p>}
          <div>{(upcoming.data || []).map((m) => <MeetingRow key={m.id} m={m} onChange={() => { void upcoming.reload(); reloadStatus() }} />)}</div>
        </section>
      </div>
      <section className="card col-side" aria-label="How sync works">
        <h2>How sync works</h2>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>The meeting is saved in the CRM first and logged on the linked record.</li>
          <li>It’s then created in your own Google Calendar, invites go to attendees, and the Meet link comes back here.</li>
          <li>The CRM keeps the Google event ID, so changing or cancelling the meeting updates that same event. It never adds a duplicate.</li>
          <li>A sync counts as done only once Google confirms it. Failures stay on the meeting with a retry, and appear under Calendar sync status.</li>
        </ul>
      </section>
    </div>
  )
}

const LEGACY_KEY = 'ls-crm-booking-links'

function BookingTab() {
  const { user } = useSession()
  const links = useLoad(() => api<BookingLink[]>('/booking-links'), [])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState('')
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [legacy, setLegacy] = useState<{ name: string; url: string }[]>(() => {
    try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]') as { name: string; url: string }[] } catch { return [] }
  })
  const can = (l: BookingLink) => l.owner_id === user.id || user.role === 'admin'

  async function add(body: { name: string; url: string }) {
    await api('/booking-links', { method: 'POST', body })
  }
  function submit() {
    setError(null)
    add({ name: name.trim(), url: url.trim() }).then(() => { setName(''); setUrl(''); void links.reload() }).catch((e: ApiError) => setError(e))
  }
  async function moveLegacy() {
    setError(null)
    try {
      for (const l of legacy) await add(l)
      try { localStorage.removeItem(LEGACY_KEY) } catch { /* ignore */ }
      setLegacy([])
      void links.reload()
    } catch (e) { setError(e as ApiError) }
  }
  const change = (l: BookingLink, method: 'PATCH' | 'DELETE', body?: unknown) =>
    api(`/booking-links/${l.id}`, { method, body }).then(() => links.reload()).catch((e: ApiError) => setError(e))
  async function copy(l: BookingLink) {
    try { await navigator.clipboard.writeText(l.url); setCopied(l.url) } catch { setError(new Error('Couldn’t copy. Select the link and copy it by hand.')) }
  }

  return (
    <div className="cols">
      <section className="card col-main" aria-label="Team booking links">
        <h2>Team booking links</h2>
        <ErrorBanner error={links.error || error} onClose={() => setError(null)} />
        {legacy.length > 0 && (
          <Banner kind="warn">{legacy.length} booking link{legacy.length === 1 ? ' is' : 's are'} saved only in this browser. <button type="button" className="btn" onClick={() => void moveLegacy()}>Share with the team</button></Banner>
        )}
        {(links.data || []).length === 0 && <p className="muted" style={{ margin: 0 }}>No booking links yet. Add one from Google Calendar below.</p>}
        <div>
          {(links.data || []).map((l) => (
            <div className="list-row" key={l.id} style={{ opacity: l.active ? 1 : 0.6 }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{l.name}</strong> <span className="muted small">· {l.owner_name}{l.active ? '' : ' · off'}</span><br /><a href={l.url} target="_blank" rel="noreferrer" className="small">{l.url}</a></span>
              <span className="row">
                <button type="button" className="btn btn-outline" onClick={() => void copy(l)}>{copied === l.url ? 'Copied' : 'Copy link'}</button>
                {can(l) && <button type="button" className="btn" onClick={() => void change(l, 'PATCH', { active: !l.active })}>{l.active ? 'Turn off' : 'Turn on'}</button>}
                {can(l) && <button type="button" className="btn" onClick={() => void change(l, 'DELETE')}>Remove</button>}
              </span>
            </div>
          ))}
        </div>
        <div className="grid-fields">
          <TextField label="Name" value={name} onChange={setName} placeholder="30-min discovery call" />
          <TextField label="Booking page link" value={url} onChange={setUrl} placeholder="https://calendar.app.google/…" />
        </div>
        <div className="row"><button type="button" className="btn btn-dark" onClick={submit}>+ Add booking link</button></div>
      </section>
      <section className="card col-side" aria-label="How to create a booking page">
        <h2>Create a booking page in Google Calendar</h2>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>Open Google Calendar, click <strong>Create › Appointment schedule</strong>.</li>
          <li>Set the duration, your bookable hours, a buffer (e.g. 15 min) and minimum notice (e.g. 24 h).</li>
          <li>Turn on <strong>Google Meet</strong> and keep “Check calendar availability” on, so only free times show.</li>
          <li>Save, click <strong>Share › Copy link</strong> and add it here.</li>
        </ol>
        <p className="muted small" style={{ margin: 0 }}>Bookings land in your Google Calendar with a Meet link; Google handles the free/busy check and the invites.</p>
      </section>
    </div>
  )
}

const CONN: Record<string, [string, string]> = { connected: ['Connected', 'teal'], needs_reconnect: ['Needs reconnect', 'red'] }

function SyncTab() {
  const { user } = useSession()
  const { data, error } = useLoad(() => api<CalendarSyncStatus>('/calendar/sync-status'), [])
  return (
    <>
      <section className="card" aria-label="Calendar sync status">
        <div className="card-head"><h2>Calendar sync status</h2><span className="muted small">{user.role === 'salesperson' ? 'Your connection' : 'Everyone on the team'}</span></div>
        <ErrorBanner error={error} />
        <div className="table-wrap">
          <table style={{ minWidth: 680 }}>
            <thead><tr><th>User</th><th>Google Calendar</th><th>Last sync</th><th>Not yet in Calendar</th><th>Booking links</th></tr></thead>
            <tbody>
              {(data?.users || []).map((u) => {
                const [label, pill] = CONN[u.status || ''] || ['Not connected', 'grey']
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.name}<div className="sub">{u.email}</div></td>
                    <td><span className={`pill pill-${pill}`}>{label}</span>{u.last_error && <div className="sub" style={{ color: 'var(--red-ink)' }}>{u.last_error}</div>}</td>
                    <td className="muted">{u.last_sync_at ? fmtDateTime(u.last_sync_at) : '—'}</td>
                    <td>{u.unsynced ? <span className="pill pill-amber">{u.unsynced}</span> : '0'}</td>
                    <td>{u.booking_links}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-label="Sync log">
        <h2>Sync log</h2>
        {(data?.log || []).length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing synced yet.</p>}
        <div>
          {(data?.log || []).map((l, i) => (
            <div className="list-row" key={i}>
              <span style={{ flex: '1 1 320px' }}><strong>{l.meeting_title || l.action}</strong> <span className="muted small">· {l.user_name} · {l.action}</span><br /><span className="small">{l.message}</span></span>
              <span className="row"><span className="muted small">{fmtDateTime(l.at)}</span><span className={`pill pill-${l.ok ? 'teal' : 'red'}`}>{l.ok ? 'OK' : 'Failed'}</span></span>
            </div>
          ))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Each user authorises their own calendar. The Google app is Internal (leadstrategus.com accounts only), and refresh tokens are stored encrypted on the server.</p>
      </section>
    </>
  )
}

export default function Meetings() {
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>('schedule')
  const status = useLoad(() => api<CalendarStatus>('/calendar/status'), [])
  const returned = params.get('calendar')
  const message = params.get('message')
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Meetings &amp; booking links</h1>
          <p>Meetings live in each person’s own Google Calendar with a Google Meet link. The CRM records them on the linked prospect or opportunity and shows every sync failure.</p>
        </div>
      </div>
      {returned === 'connected' && <Banner onClose={() => setParams({})}>Google Calendar connected. Meetings waiting to sync have been sent.</Banner>}
      {returned === 'error' && <Banner kind="err" onClose={() => setParams({})}>{message || 'Google Calendar wasn’t connected.'}</Banner>}
      <ErrorBanner error={status.error} />
      {status.data && <ConnectionBar status={status.data} onChange={() => void status.reload()} />}
      <Tabs<Tab> label="Meetings sections" value={tab} onChange={setTab}
        tabs={[{ value: 'schedule', label: 'Schedule a meeting' }, { value: 'booking', label: 'Booking links' }, { value: 'sync', label: 'Calendar sync status' }]} />
      {tab === 'schedule' && status.data && <ScheduleTab status={status.data} reloadStatus={() => void status.reload()} />}
      {tab === 'booking' && <BookingTab />}
      {tab === 'sync' && <SyncTab />}
    </>
  )
}
