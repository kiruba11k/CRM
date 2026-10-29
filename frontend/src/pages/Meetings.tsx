// §6 Meetings & booking links. Until the Calendar API backend (Phase 4)
// lands, scheduling opens a pre-filled Google Calendar event in the user's
// own calendar and logs the meeting on the linked record, so nothing is
// silently dropped and no sync is claimed that didn't happen.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDateTime } from '../format'
import { useSession } from '../session'
import type { Opportunity, Prospect } from '../types'
import { Banner, ErrorBanner, SelectField, Tabs, TextField, useLoad } from '../ui'

type Tab = 'schedule' | 'booking' | 'sync'
interface BookingLink { name: string; url: string }

const LINKS_KEY = 'ls-crm-booking-links'
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

// "2026-10-29T14:30" + minutes → Google's local "20261029T143000" form.
function calStamp(local: string, addMinutes = 0): string {
  const d = new Date(local)
  d.setMinutes(d.getMinutes() + addMinutes)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`
}

function calendarUrl(f: { title: string; when: string; minutes: number; attendees: string; details: string }): string {
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: f.title, dates: `${calStamp(f.when)}/${calStamp(f.when, f.minutes)}`, ctz: tz,
    details: f.details, add: f.attendees.split(/[\s,;]+/).filter(Boolean).join(','),
  })
  return `https://calendar.google.com/calendar/render?${q.toString()}`
}

function ScheduleTab() {
  const opps = useLoad(() => api<Opportunity[]>('/opportunities', { params: { open_only: true, include_nurtured: true } }), [])
  const prospects = useLoad(() => api<Prospect[]>('/prospects', { params: { scope: 'all' } }), [])
  const [record, setRecord] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [attendees, setAttendees] = useState('')
  const [when, setWhen] = useState('')
  const [minutes, setMinutes] = useState<string | null>('30')
  const [log, setLog] = useState(true)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [done, setDone] = useState('')

  const options = [
    ...(opps.data || []).map((o) => ({ value: `opportunity:${o.id}`, label: `Opportunity · ${o.account_name} · ${o.name}` })),
    ...(prospects.data || []).filter((p) => p.status !== 'Disqualified').map((p) => ({ value: `prospect:${p.id}`, label: `Prospect · ${p.full_name}${p.account_name ? ` (${p.account_name})` : ''}` })),
  ]

  function pickRecord(v: string | null) {
    setRecord(v)
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

  async function schedule() {
    setError(null)
    setDone('')
    if (!title.trim() || !when) { setError(new Error('Add a title and a date & time.')); return }
    const url = calendarUrl({ title, when, minutes: Number(minutes || 30), attendees, details: 'Scheduled from LeadStrategus CRM.' })
    window.open(url, '_blank', 'noopener')
    if (log && record) {
      const [kind, id] = record.split(':')
      try {
        await api(`/${kind === 'prospect' ? 'prospects' : 'opportunities'}/${id}/activities`, {
          method: 'POST', body: { kind: 'meeting', summary: `Meeting scheduled: ${title} · ${fmtDateTime(new Date(when).toISOString())}${attendees ? ` · with ${attendees}` : ''}` },
        })
      } catch (e) { setError(e as ApiError); return }
    }
    setDone(log && record ? 'Opened in Google Calendar and logged on the record’s timeline.' : 'Opened in Google Calendar.')
  }

  return (
    <div className="cols">
      <section className="card strong col-main" aria-label="Schedule from the CRM">
        <h2>Schedule from the CRM</h2>
        <ErrorBanner error={opps.error || prospects.error || error} onClose={() => setError(null)} />
        {done && <Banner onClose={() => setDone('')}>{done} Save the event in the Calendar tab that opened.</Banner>}
        <div className="grid-fields">
          <SelectField label="Linked record" value={record} onChange={pickRecord} options={options} placeholder="Not linked" />
          <TextField label="Title" required value={title} onChange={setTitle} />
          <TextField label="Attendees" value={attendees} onChange={setAttendees} placeholder="name@company.com, …" hint="Separate emails with commas" />
          <Field2 label="Date & time" value={when} onChange={setWhen} />
          <SelectField label="Duration" value={minutes} onChange={setMinutes} options={[{ value: '15', label: '15 minutes' }, { value: '30', label: '30 minutes' }, { value: '45', label: '45 minutes' }, { value: '60', label: '1 hour' }]} />
        </div>
        <label className="check"><input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} disabled={!record} /> Log this meeting on the linked record</label>
        <div className="row">
          <button type="button" className="btn btn-dark" onClick={() => void schedule()}>Open in Google Calendar</button>
          <span className="muted small">In Calendar, click “Add Google Meet video conferencing”; your Calendar’s default reminders apply.</span>
        </div>
      </section>
      <section className="card col-side" aria-label="Calendar sync">
        <h2>Direct Calendar sync</h2>
        <p className="muted small" style={{ margin: 0 }}>Next phase: the CRM creates the event itself in your Google Calendar with a Meet link, stores the event ID so updates never create a duplicate, and shows every sync failure with a retry.</p>
        <span className="pill pill-amber" style={{ alignSelf: 'flex-start' }}>Not connected yet · Phase 4</span>
      </section>
    </div>
  )
}

// datetime-local isn't one of TextField's types; keep the same field styling.
function Field2({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="meeting-when">{label} <span className="req" aria-hidden="true">*</span></label>
      <input id="meeting-when" type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="hint">Your time zone: {tz}</span>
    </div>
  )
}

function loadLinks(): BookingLink[] {
  try { return JSON.parse(localStorage.getItem(LINKS_KEY) || '[]') as BookingLink[] } catch { return [] }
}

function BookingTab() {
  const [links, setLinks] = useState<BookingLink[]>(loadLinks)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const save = (next: BookingLink[]) => {
    setLinks(next)
    try { localStorage.setItem(LINKS_KEY, JSON.stringify(next)) } catch { /* private mode: keep in memory */ }
  }
  function add() {
    setError('')
    if (!name.trim()) { setError('Give the link a name, e.g. “30-min discovery call”.'); return }
    if (!/^https:\/\/(calendar\.app\.google|calendar\.google\.com)\//.test(url.trim())) { setError('Paste the booking page link from Google Calendar (it starts with https://calendar.app.google/ or https://calendar.google.com/).'); return }
    save([...links, { name: name.trim(), url: url.trim() }])
    setName('')
    setUrl('')
  }
  async function copy(l: BookingLink) {
    try { await navigator.clipboard.writeText(l.url); setCopied(l.url) } catch { setError('Couldn’t copy. Select the link and copy it by hand.') }
  }
  return (
    <div className="cols">
      <section className="card col-main" aria-label="Your booking links">
        <h2>Your booking links</h2>
        {links.length === 0 && <p className="muted" style={{ margin: 0 }}>No booking links yet. Add one from Google Calendar below.</p>}
        <div>
          {links.map((l) => (
            <div className="list-row" key={l.url}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{l.name}</strong><br /><a href={l.url} target="_blank" rel="noreferrer" className="small">{l.url}</a></span>
              <span className="row">
                <button type="button" className="btn btn-outline" onClick={() => void copy(l)}>{copied === l.url ? 'Copied' : 'Copy link'}</button>
                <button type="button" className="btn" onClick={() => save(links.filter((x) => x.url !== l.url))}>Remove</button>
              </span>
            </div>
          ))}
        </div>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        <div className="grid-fields">
          <TextField label="Name" value={name} onChange={setName} placeholder="30-min discovery call" />
          <TextField label="Booking page link" value={url} onChange={setUrl} placeholder="https://calendar.app.google/…" />
        </div>
        <div className="row"><button type="button" className="btn btn-dark" onClick={add}>+ Add booking link</button></div>
        <span className="muted small">Saved in this browser for now; links shared across the team arrive with the Calendar backend (Phase 4).</span>
      </section>
      <section className="card col-side" aria-label="How to create a booking page">
        <h2>Create a booking page in Google Calendar</h2>
        <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>Open Google Calendar, click <strong>Create › Appointment schedule</strong>.</li>
          <li>Set the duration, your bookable hours, a buffer (e.g. 15 min) and minimum notice (e.g. 24 h).</li>
          <li>Turn on <strong>Google Meet</strong> for the video call and check “Check calendar availability”, so only free times show.</li>
          <li>Save, click <strong>Share › Copy link</strong> and paste it here.</li>
        </ol>
        <p className="muted small" style={{ margin: 0 }}>Appointment schedules with booking pages are included in Google Workspace business plans.</p>
      </section>
    </div>
  )
}

function SyncTab() {
  const { users } = useSession()
  return (
    <section className="card" aria-label="Calendar sync status">
      <div className="card-head"><h2>Calendar sync status</h2><span className="pill pill-amber">Not connected yet · Phase 4</span></div>
      <div className="table-wrap">
        <table style={{ minWidth: 560 }}>
          <thead><tr><th>User</th><th>Google Calendar</th><th>Last sync</th></tr></thead>
          <tbody>
            {users.filter((u) => u.active !== false).map((u) => (
              <tr key={u.id}><td style={{ fontWeight: 600 }}>{u.name}</td><td><span className="pill pill-grey">Not connected</span></td><td className="muted">—</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ margin: 0 }}>When Calendar sync is on, each user authorises their own calendar, the Google app is Internal (leadstrategus.com accounts only), and a sync is reported as done only after Google confirms it. Failures appear here with a retry.</p>
    </section>
  )
}

export default function Meetings() {
  const [tab, setTab] = useState<Tab>('schedule')
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Meetings &amp; booking links</h1>
          <p>Meetings live in each person’s own Google Calendar with a Google Meet link. The CRM records them on the linked prospect or opportunity.</p>
        </div>
      </div>
      <Tabs<Tab> label="Meetings sections" value={tab} onChange={setTab}
        tabs={[{ value: 'schedule', label: 'Schedule a meeting' }, { value: 'booking', label: 'Booking links' }, { value: 'sync', label: 'Calendar sync status' }]} />
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'booking' && <BookingTab />}
      {tab === 'sync' && <SyncTab />}
    </>
  )
}
