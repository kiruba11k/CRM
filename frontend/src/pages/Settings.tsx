// §8 Settings: controlled lists and stage probabilities, reminders, users
// & roles, Google integrations, export & backup, the shared launch
// checklist (§9, §10) and a log of every settings change.
import { useEffect, useState } from 'react'
import { ApiError, api, downloadCsv } from '../api'
import { fmtDateTime } from '../format'
import { can, useSession } from '../session'
import PeopleAccess from '../components/PeopleAccess'
import SlackSettings from '../components/SlackSettings'
import type { CalendarStatus, ChecklistItem, DigestMe, DigestPreview, EditableList, ReminderSettings, SettingsChange, SettingsView } from '../types'
import { Banner, ErrorBanner, Tabs, TextField, useLoad } from '../ui'

type Tab = 'lists' | 'reminders' | 'roles' | 'integrations' | 'slack' | 'data' | 'launch' | 'log'
type Tag = 'required' | 'confirm' | 'configurable'

const TAG: Record<Tag, { label: string; pill: string }> = {
  required: { label: 'Fixed v2 rule', pill: 'paper' },
  confirm: { label: 'Confirm before production', pill: 'amber' },
  configurable: { label: 'Configurable', pill: 'teal' },
}

type Panel = { kind: 'fixed'; id: string } | { kind: 'stages' } | { kind: 'list'; key: EditableList }
const EDITABLE: { key: EditableList; tag: Tag; note: string }[] = [
  { key: 'nurture_reasons', tag: 'configurable', note: 'Required when Put on Nurture = Yes.' },
  { key: 'lost_reasons', tag: 'configurable', note: 'Required when an opportunity is marked Lost. Optional notes go in a separate field.' },
  { key: 'service_lines', tag: 'confirm', note: 'Spec examples. Confirm the exact services before launch.' },
  { key: 'sources', tag: 'configurable', note: 'Used for prospects and deal source.' },
  { key: 'account_statuses', tag: 'configurable', note: '' },
  { key: 'currencies', tag: 'confirm', note: 'Multi-currency is on. Unlike currencies are never summed until an FX rule is agreed. Use three-letter ISO codes.' },
]

// Admin edits return the whole settings view; refresh the session's lists too.
function useSettingsAction(onView: (v: SettingsView) => void) {
  const { refreshLists } = useSession()
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown) {
    setBusy(true)
    setError(null)
    try {
      onView(await api<SettingsView>(path, { method, body }))
      await refreshLists()
      return true
    } catch (e) { setError(e as ApiError); return false } finally { setBusy(false) }
  }
  return { run, error, setError, busy }
}

function FixedList({ id }: { id: string }) {
  const { lists } = useSession()
  const fixed: Record<string, { name: string; note: string; items: [string, string][] }> = {
    next_actions: { name: 'Next actions', note: `Shared by prospects and opportunities. Free text only through “Other”, which needs a description of ${lists.other_max_length} characters or fewer.`,
      items: lists.next_actions.map((n) => [n.code, n.label]) },
    prospect_statuses: { name: 'Prospect statuses', note: 'Separate from the opportunity flag “Put on Nurture?”: prospects and opportunities have different lifecycles.',
      items: lists.prospect_statuses.map((s, i) => [String(i + 1).padStart(2, '0'), s]) },
    risk_ratings: { name: 'Risk ratings', note: 'Qualified and later need a rating; High needs a reason and a mitigation.',
      items: lists.risk_ratings.map((s, i) => [String(i + 1).padStart(2, '0'), s]) },
  }
  const d = fixed[id]
  return (
    <section className="card col-main" aria-label={d.name}>
      <div className="card-head"><h2>{d.name}</h2><span className={`pill pill-${TAG.required.pill}`}>{TAG.required.label}</span></div>
      <p className="muted" style={{ margin: 0 }}>{d.note} These values are fixed by the v2 specification, so they aren’t editable.</p>
      <div>{d.items.map(([code, label]) => <div className="list-row" key={code}><span><span className="mono muted">{code}</span>&nbsp;&nbsp;{label}</span></div>)}</div>
    </section>
  )
}

function StagesPanel({ view, onView, admin }: { view: SettingsView; onView: (v: SettingsView) => void; admin: boolean }) {
  const [probs, setProbs] = useState<Record<string, string>>(() => Object.fromEntries(view.stages.map((s) => [s.name, String(s.probability)])))
  const [saved, setSaved] = useState(false)
  const act = useSettingsAction(onView)
  const changed = view.stages.some((s) => s.editable && String(s.probability) !== probs[s.name])
  async function save() {
    setSaved(false)
    const body = { probabilities: Object.fromEntries(view.stages.filter((s) => s.editable).map((s) => [s.name, Number(probs[s.name])])) }
    if (await act.run('/settings/stages', 'PUT', body)) setSaved(true)
  }
  return (
    <section className="card col-main" aria-label="Opportunity stages">
      <div className="card-head"><h2>Opportunity stages</h2><span className={`pill pill-${TAG.confirm.pill}`}>{TAG.confirm.label}</span></div>
      <p className="muted" style={{ margin: 0 }}>Stage names are fixed. Probabilities are starter values: recalibrate them from real conversion data after the pilot. Weighted value = estimated value × probability, so a change updates every forecast at once.</p>
      <ErrorBanner error={act.error} onClose={() => act.setError(null)} />
      {saved && <Banner onClose={() => setSaved(false)}>Probabilities saved. Forecasts now use them.</Banner>}
      <div>
        {view.stages.map((s, i) => (
          <div className="list-row" key={s.name}>
            <span><span className="mono muted">{String(i + 1).padStart(2, '0')}</span>&nbsp;&nbsp;{s.name}{s.editable && s.probability !== s.default ? <span className="muted small"> · spec default {s.default}%</span> : ''}</span>
            {s.editable && admin ? (
              <span className="row" style={{ gap: 6 }}>
                <input className="input" style={{ width: 80 }} type="number" min={1} max={99} aria-label={`${s.name} probability`}
                  value={probs[s.name]} onChange={(e) => setProbs({ ...probs, [s.name]: e.target.value })} /> %
              </span>
            ) : <span className="pill pill-grey">{s.probability}%</span>}
          </div>
        ))}
      </div>
      {admin && <div className="row"><button type="button" className="btn btn-dark" disabled={!changed || act.busy} onClick={() => void save()}>Save probabilities</button>
        <span className="muted small">Must rise with each stage, between 1% and 99%. Won is always 100%, Lost 0%.</span></div>}
    </section>
  )
}

function EditableListPanel({ listKey, view, onView, admin }: { listKey: EditableList; view: SettingsView; onView: (v: SettingsView) => void; admin: boolean }) {
  const def = EDITABLE.find((e) => e.key === listKey)!
  const list = view.lists[listKey]
  const [adding, setAdding] = useState('')
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)
  const act = useSettingsAction(onView)
  const values = list.options.map((o) => o.value)
  const dropAt = (to: number) => {
    if (!drag || drag.from === to) { setDrag(null); return }
    const next = [...values]
    const [item] = next.splice(drag.from, 1)
    next.splice(to, 0, item)
    setDrag(null)
    void act.run(`/settings/lists/${listKey}/order`, 'PUT', { values: next })
  }
  const move = (i: number, d: number) => {
    const next = [...values]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    void act.run(`/settings/lists/${listKey}/order`, 'PUT', { values: next })
  }
  return (
    <section className="card col-main" aria-label={list.label}>
      <div className="card-head"><h2>{list.label}</h2><span className={`pill pill-${TAG[def.tag].pill}`}>{TAG[def.tag].label}</span></div>
      {def.note && <p className="muted" style={{ margin: 0 }}>{def.note}</p>}
      <ErrorBanner error={act.error} onClose={() => act.setError(null)} />
      <div>
        {list.options.map((o, i) => (
          <div key={o.value} style={{ opacity: o.active ? 1 : 0.65 }}
            className={`list-row${drag?.from === i ? ' dragging' : ''}${drag && drag.over === i && drag.from !== i ? ' drag-over' : ''}`}
            draggable={admin && !renaming && !act.busy}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', o.value); setDrag({ from: i, over: null }) }}
            onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }) } }}
            onDrop={(e) => { e.preventDefault(); dropAt(i) }}
            onDragEnd={() => setDrag(null)}>
            {renaming?.from === o.value ? (
              <span className="row" style={{ flex: '1 1 260px' }}>
                <input className="input" aria-label={`New name for ${o.value}`} value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })} />
                <button type="button" className="btn btn-dark" disabled={act.busy}
                  onClick={() => void act.run(`/settings/lists/${listKey}`, 'PATCH', { value: o.value, rename_to: renaming.to }).then((ok) => ok && setRenaming(null))}>Save</button>
                <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
              </span>
            ) : (
              <span style={{ flex: '1 1 260px' }}>
                {admin && <span className="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>}<span className="mono muted">{String(i + 1).padStart(2, '0')}</span>&nbsp;&nbsp;{o.value}
                <span className="muted small"> · {o.in_use} record{o.in_use === 1 ? '' : 's'}</span>
                {!o.active && <span className="pill pill-grey" style={{ marginLeft: 8 }}>Retired</span>}
                {o.protected && <span className="pill pill-paper" style={{ marginLeft: 8 }}>Used by the CRM</span>}
              </span>
            )}
            {admin && renaming?.from !== o.value && (
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="btn" aria-label={`Move ${o.value} up`} disabled={i === 0 || act.busy} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn" aria-label={`Move ${o.value} down`} disabled={i === list.options.length - 1 || act.busy} onClick={() => move(i, 1)}>↓</button>
                {listKey !== 'currencies' && !o.protected && <button type="button" className="btn" onClick={() => setRenaming({ from: o.value, to: o.value })}>Rename</button>}
                {!o.protected && <button type="button" className="btn" disabled={act.busy}
                  onClick={() => void act.run(`/settings/lists/${listKey}`, 'PATCH', { value: o.value, active: !o.active })}>{o.active ? 'Retire' : 'Restore'}</button>}
              </span>
            )}
          </div>
        ))}
      </div>
      {admin ? (
        <>
          <div className="row-end">
            <div style={{ flex: '1 1 260px' }}><TextField label="Add an option" value={adding} onChange={setAdding} placeholder={listKey === 'currencies' ? 'e.g. CHF' : 'New option'} /></div>
            <button type="button" className="btn btn-dark" disabled={!adding.trim() || act.busy}
              onClick={() => void act.run(`/settings/lists/${listKey}`, 'POST', { value: adding }).then((ok) => ok && setAdding(''))}>Add</button>
          </div>
          <span className="muted small">Drag ⠿ or use ↑ ↓ to reorder. Renaming updates every record that uses the option. Retiring hides it from dropdowns; records that already use it keep it.</span>
        </>
      ) : <span className="muted small">Only admins change controlled lists.</span>}
    </section>
  )
}

function ListsTab({ view, onView }: { view: SettingsView; onView: (v: SettingsView) => void }) {
  const { user } = useSession()
  const admin = can(user, 'manage_settings')
  const [panel, setPanel] = useState<Panel>({ kind: 'list', key: 'nurture_reasons' })
  const fixedNames: [string, string][] = [['next_actions', 'Next actions'], ['prospect_statuses', 'Prospect statuses'], ['risk_ratings', 'Risk ratings']]
  const isSel = (p: Panel) => JSON.stringify(p) === JSON.stringify(panel)
  return (
    <div className="cols">
      <div className="card col-side" style={{ flexBasis: 240 }}>
        <div className="side-list" role="group" aria-label="Lists">
          {EDITABLE.map((e) => (
            <button key={e.key} type="button" aria-pressed={isSel({ kind: 'list', key: e.key })} onClick={() => setPanel({ kind: 'list', key: e.key })}>
              <span>{view.lists[e.key].label}</span><span className="muted small">{view.lists[e.key].options.filter((o) => o.active).length}</span>
            </button>
          ))}
          <button type="button" aria-pressed={isSel({ kind: 'stages' })} onClick={() => setPanel({ kind: 'stages' })}>
            <span>Opportunity stages</span><span className="muted small">{view.stages.length}</span>
          </button>
          {fixedNames.map(([id, name]) => (
            <button key={id} type="button" aria-pressed={isSel({ kind: 'fixed', id })} onClick={() => setPanel({ kind: 'fixed', id })}>
              <span>{name}</span><span className="muted small">fixed</span>
            </button>
          ))}
        </div>
      </div>
      {panel.kind === 'list' && <EditableListPanel key={panel.key} listKey={panel.key} view={view} onView={onView} admin={admin} />}
      {panel.kind === 'stages' && <StagesPanel view={view} onView={onView} admin={admin} />}
      {panel.kind === 'fixed' && <FixedList id={panel.id} />}
    </div>
  )
}

const SWITCHES: { key: keyof ReminderSettings; trigger: string; behaviour: string }[] = [
  { key: 'meeting_15', trigger: 'Meeting in Calendar', behaviour: '15-minute reminder before the meeting (default for new meetings)' },
  { key: 'meeting_day', trigger: 'Meeting in Calendar (optional)', behaviour: 'Day-before reminder (default for new meetings)' },
  { key: 'due_before', trigger: 'Next action due (optional)', behaviour: 'Flag actions due the next business day in My Actions' },
  { key: 'escalation', trigger: 'Manager escalation', behaviour: 'Flag an action to managers when it stays overdue' },
]
const ALWAYS: [string, string][] = [
  ['Next action due', 'Shown in Due today in My Actions on the due date'],
  ['Overdue action', 'Stays in My Actions until done, rescheduled or closed'],
  ['Nurture revisit date', 'Reminder on the revisit date; no routine active-deal nudges while nurtured'],
]

function timeZones(current: string): string[] {
  let zones: string[] = []
  try { zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') || [] } catch { /* old browser */ }
  if (!zones.length) zones = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Stockholm', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'America/New_York', 'America/Chicago', 'America/Los_Angeles']
  return Array.from(new Set(['UTC', current, ...zones]))
}

// Everyone: their own digest switch, a preview, and a test send. Admins can
// also send today's digests straight away.
function DigestCard({ reminders }: { reminders: ReminderSettings }) {
  const { user } = useSession()
  const me = useLoad(() => api<DigestMe>('/digest/me'), [])
  const [preview, setPreview] = useState<DigestPreview | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState('')
  const call = async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key); setError(null); setMsg('')
    try { return await fn() } catch (e) { setError(e as ApiError); return null } finally { setBusy('') }
  }
  const d = me.data
  const LAST: Record<string, string> = { sent: 'Sent', skipped: 'Not sent: nothing due', failed: 'Failed', sending: 'Sending' }
  return (
    <section className="card" aria-label="My daily digest">
      <div className="card-head"><h2>My daily digest</h2>{d && <span className="muted small">to {d.email}</span>}</div>
      <ErrorBanner error={error || me.error} onClose={() => setError(null)} />
      {msg && <Banner onClose={() => setMsg('')}>{msg}</Banner>}
      {d && !d.configured && <Banner kind="warn">Email isn’t set up on the server yet, so no digests go out. An admin adds CRM_SMTP_HOST, CRM_SMTP_USER and CRM_SMTP_PASSWORD on the Render API service. You can still preview yours.</Banner>}
      {d && <>
        <div className="list-row">
          <span style={{ flex: '1 1 320px' }}><strong>Send me the daily digest</strong><br /><span className="muted small">
            {reminders.digest ? `Around ${String(reminders.digest_hour).padStart(2, '0')}:00 ${reminders.digest_time_zone}${reminders.digest_weekdays_only ? ' on weekdays' : ''}` : 'Turned off for everyone by an admin'}
            {d.last ? ` · Last: ${LAST[d.last.status] || d.last.status} (${d.last.digest_date})${d.last.status === 'failed' && d.last.detail ? `: ${d.last.detail}` : ''}` : ''}
          </span></span>
          <label className="check"><input type="checkbox" checked={d.enabled} disabled={busy === 'pref'}
            onChange={(e) => { const enabled = e.target.checked; void call('pref', () => api<DigestMe>('/digest/me', { method: 'PATCH', body: { enabled } })).then((r) => { if (r) void me.reload() }) }} /> {d.enabled ? 'On' : 'Off'}</label>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline" disabled={!!busy} onClick={() => void call('preview', () => api<DigestPreview>('/digest/preview')).then((p) => p && setPreview(p))}>{busy === 'preview' ? 'Building…' : 'Preview today’s digest'}</button>
          <button type="button" className="btn" disabled={!!busy || !d.configured} onClick={() => void call('test', () => api<{ sent_to: string }>('/digest/test', { method: 'POST', body: {} })).then((r) => r && setMsg(`Test digest sent to ${r.sent_to}.`))}>{busy === 'test' ? 'Sending…' : 'Email me a test'}</button>
          {can(user, 'manage_settings') && <button type="button" className="btn" disabled={!!busy || !d.configured}
            onClick={() => void call('run', () => api<{ sent: number; skipped: number; failed: number; already: number }>('/digest/run', { method: 'POST', body: {} }))
              .then((r) => { if (r) { setMsg(`Digests: ${r.sent} sent, ${r.skipped} with nothing due, ${r.already} already sent today${r.failed ? `, ${r.failed} failed` : ''}.`); void me.reload() } })}>
            {busy === 'run' ? 'Sending…' : 'Send today’s digests now'}</button>}
        </div>
      </>}
      {preview && <>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small"><strong>Subject:</strong> {preview.subject}{!preview.worth_sending && <span className="muted"> · nothing due, so this wouldn’t be sent today</span>}</span>
          <button type="button" className="btn" onClick={() => setPreview(null)}>Close preview</button>
        </div>
        <iframe className="digest-frame" title="Digest preview" sandbox="" srcDoc={preview.html} />
      </>}
    </section>
  )
}

function RemindersTab({ view, onView }: { view: SettingsView; onView: (v: SettingsView) => void }) {
  const { user } = useSession()
  const admin = can(user, 'manage_settings')
  const act = useSettingsAction(onView)
  // Show the change at once; fall back to the saved values if it fails.
  const [r, setR] = useState<ReminderSettings>(view.reminders)
  useEffect(() => setR(view.reminders), [view.reminders])
  const set = (patch: Partial<ReminderSettings>) => {
    setR((cur) => ({ ...cur, ...patch }))
    void act.run('/settings/reminders', 'PUT', patch).then((ok) => { if (!ok) setR(view.reminders) })
  }
  return (
    <>
    <section className="card" aria-label="Reminders">
      <h2>Reminders (§5)</h2>
      <ErrorBanner error={act.error} onClose={() => act.setError(null)} />
      <div>
        {SWITCHES.map((s) => (
          <div className="list-row" key={s.key}>
            <span style={{ flex: '1 1 320px' }}><strong>{s.trigger}</strong><br /><span className="muted small">{s.behaviour}</span></span>
            {admin ? (
              <label className="check"><input type="checkbox" checked={!!r[s.key]} onChange={(e) => set({ [s.key]: e.target.checked })} /> {r[s.key] ? 'On' : 'Off'}</label>
            ) : <span className={`pill pill-${r[s.key] ? 'teal' : 'grey'}`}>{r[s.key] ? 'On' : 'Off'}</span>}
          </div>
        ))}
        <div className="list-row">
          <span style={{ flex: '1 1 320px' }}><strong>Escalate after</strong><br /><span className="muted small">Business days overdue before an action is flagged to managers</span></span>
          {admin ? (
            <select className="input" aria-label="Escalate after business days" value={r.escalation_days} disabled={!r.escalation}
              onChange={(e) => set({ escalation_days: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 7, 10].map((n) => <option key={n} value={n}>{n} business day{n === 1 ? '' : 's'}</option>)}
            </select>
          ) : <span className="pill pill-grey">{r.escalation_days} business days</span>}
        </div>
        <div className="list-row">
          <span style={{ flex: '1 1 320px' }}><strong>Deal going quiet</strong><br /><span className="muted small">Flag an open deal on My Actions, the Pipeline and the digest when nothing has happened on it for this long</span></span>
          {admin ? (
            <select className="input" aria-label="Going quiet after days" value={r.stale_days} onChange={(e) => set({ stale_days: Number(e.target.value) })}>
              {[7, 10, 14, 21, 30, 45, 60].map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
          ) : <span className="pill pill-grey">{r.stale_days} days</span>}
        </div>
        <div className="list-row">
          <span style={{ flex: '1 1 320px' }}><strong>Daily digest email</strong><br /><span className="muted small">Each morning: overdue and due-today actions, deals going quiet and the quarter so far; managers also get a team summary. People with nothing due get no email.</span></span>
          {admin ? (
            <label className="check"><input type="checkbox" checked={!!r.digest} onChange={(e) => set({ digest: e.target.checked })} /> {r.digest ? 'On' : 'Off'}</label>
          ) : <span className={`pill pill-${r.digest ? 'teal' : 'grey'}`}>{r.digest ? 'On' : 'Off'}</span>}
        </div>
        <div className="list-row">
          <span style={{ flex: '1 1 320px' }}><strong>Digest send time</strong><br /><span className="muted small">Sent at or shortly after this hour, in this time zone</span></span>
          {admin ? (
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" aria-label="Digest hour" value={r.digest_hour} disabled={!r.digest} onChange={(e) => set({ digest_hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
              <select className="input" aria-label="Digest time zone" value={r.digest_time_zone} disabled={!r.digest} onChange={(e) => set({ digest_time_zone: e.target.value })}>
                {timeZones(r.digest_time_zone).map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
              <label className="check"><input type="checkbox" checked={!!r.digest_weekdays_only} disabled={!r.digest} onChange={(e) => set({ digest_weekdays_only: e.target.checked })} /> Weekdays only</label>
            </span>
          ) : <span className="pill pill-grey">{String(r.digest_hour).padStart(2, '0')}:00 {r.digest_time_zone}{r.digest_weekdays_only ? ', weekdays' : ''}</span>}
        </div>
        {ALWAYS.map(([trigger, behaviour]) => (
          <div className="list-row" key={trigger}>
            <span style={{ flex: '1 1 320px' }}><strong>{trigger}</strong><br /><span className="muted small">{behaviour}</span></span>
            <span className="pill pill-paper">Always on (spec)</span>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>Won, Lost and Disqualified records never get open-record reminders. Nurtured opportunities only get the revisit-date reminder. Meeting reminders are set on each meeting; these are the defaults new meetings start with.</p>
      {!admin && <span className="muted small">Only admins change reminder settings.</span>}
    </section>
    <DigestCard reminders={r} />
    </>
  )
}

const INTEGRATIONS: [string, string, string, keyof typeof INTEG_STATE][] = [
  ['Google sign-in (Workspace)', 'Priority 1', 'Only leadstrategus.com accounts can sign in. The Google app is set to Internal.', 'live'],
  ['Gmail: contextual links', 'Priority 2', 'Search and compose links on accounts, prospects and opportunities. No mail is copied into the CRM.', 'live'],
  ['HubSpot import', 'Pilot', 'Read-only private-app token on the server (CRM_HUBSPOT_TOKEN). Re-runnable; never overwrites records edited in the CRM.', 'live'],
  ['Google Calendar + Meet', 'Priority 1', 'Create, update and cancel meetings in each person’s own calendar with a Meet link. Per-user sign-in, event ID stored to prevent duplicates, sync status and retry shown. Booking links use Google appointment schedules (free/busy).', 'calendar'],
  ['Gmail: thread association', 'Later, if useful', 'Link a specific thread to a record, storing only the thread ID and minimal metadata.', 'later'],
  ['Gmail: auto-log emails', 'Optional', 'Each person can turn it on (Meetings page). Emails with known prospects are logged on the prospect and their open deals; emails with anyone else at a known company (matched by email domain) are logged on the account. Headers only (who, subject, date), never message text. Internal mail is ignored; anyone can remove a logged email.', 'calendar'],
  ['Google Tasks', 'Optional', 'Each person can mirror their open next actions into a “LeadStrategus CRM” list in Google Tasks. Ticking a task off there flags it in My Actions to set the next action; changing its date reschedules it; titles stay CRM-owned.', 'calendar'],
]
const INTEG_STATE = { live: ['Live', 'teal'], planned: ['Planned', 'amber'], later: ['Deferred', 'grey'], calendar: ['', ''] } as const

function IntegrationsTab() {
  const calendar = useLoad(() => api<CalendarStatus>('/calendar/status'), [])
  const pill = (state: keyof typeof INTEG_STATE): [string, string] => state !== 'calendar' ? [INTEG_STATE[state][0], INTEG_STATE[state][1]]
    : !calendar.data ? ['…', 'grey'] : calendar.data.configured ? ['Live', 'teal'] : [`Needs server setup: ${calendar.data.missing.join(', ')}`, 'amber']
  return (
    <section className="card" aria-label="Google integrations">
      <h2>Google Workspace integrations</h2>
      <div>
        {INTEGRATIONS.map(([name, priority, desc, state]) => (
          <div className="list-row" key={name}>
            <span style={{ flex: '1 1 320px' }}><strong>{name}</strong> <span className="muted small">· {priority}</span><br /><span className="muted small">{desc}</span></span>
            <span className={`pill pill-${pill(state)[1]}`}>{pill(state)[0]}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

const EXPORTS = [['accounts', 'Accounts'], ['prospects', 'Prospects / contacts'], ['opportunities', 'Opportunities'], ['history', 'Change history (audit)']] as const

// Dummy data for trying the CRM out (admin). Fixed IDs on the server mean
// "Remove" deletes exactly the demo records and never real ones.
function DemoCard() {
  const { refreshUsers } = useSession()
  const status = useLoad(() => api<{ loaded: boolean }>('/settings/demo'), [])
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const run = (action: 'load' | 'remove') => {
    if (action === 'remove' && !window.confirm('Remove all demo data? Real records are not touched.')) return
    setBusy(true)
    setError(null)
    setMsg('')
    api<{ counts?: Record<string, number>; kept?: string[] }>('/settings/demo', { method: 'POST', body: { action } })
      .then((r) => {
        setMsg(action === 'load'
          ? `Loaded ${Object.entries(r.counts || {}).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}.`
          : `Demo data removed.${r.kept?.length ? ` Kept because real records use them: ${r.kept.join(', ')}.` : ''}`)
        void status.reload()
        void refreshUsers()
      })
      .catch((e: ApiError) => setError(e)).finally(() => setBusy(false))
  }
  const loaded = status.data?.loaded
  return (
    <section className="card" aria-label="Demo data">
      <div className="card-head"><h2>Demo data</h2>{status.data && <span className={`pill pill-${loaded ? 'amber' : 'grey'}`}>{loaded ? 'Loaded' : 'Not loaded'}</span>}</div>
      <p className="muted small" style={{ margin: 0 }}>
        Fills every screen to try the CRM out: 4 demo users (names end “(demo)”), 12 accounts, 25 prospects, 18 opportunities across all stages,
        nurture, won and lost deals in USD, EUR and GBP, activity timelines, meetings, booking links, Gmail thread links and two “Needs cleanup” records.
        Dates are set around today. Demo records belong to the demo users, so nothing is sent to anyone’s Google Calendar or Tasks.
      </p>
      <ErrorBanner error={error || status.error} onClose={() => setError(null)} />
      {msg && <Banner onClose={() => setMsg('')}>{msg}</Banner>}
      <div className="row">
        <button type="button" className="btn btn-dark" disabled={busy || loaded !== false} onClick={() => run('load')}>Load demo data</button>
        <button type="button" className="btn" disabled={busy || !loaded} onClick={() => run('remove')}>Remove demo data</button>
      </div>
      <span className="muted small">Remove deletes only the demo records. Remove it before going live.</span>
    </section>
  )
}

// Uploaded files live in the database; Neon's free plan holds 0.5 GB.
function StorageUsage() {
  const u = useLoad(() => api<{ files: number; links: number; bytes: number; db_bytes: number }>('/attachments/usage/summary'), [])
  if (!u.data) return null
  const mb = (b: number) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`
  const pct = Math.min(100, (u.data.db_bytes / (512 * 1048576)) * 100)
  return (
    <>
      <h2>File storage</h2>
      <p className="muted small" style={{ margin: 0 }}>
        {u.data.files} uploaded file{u.data.files === 1 ? '' : 's'} ({mb(u.data.bytes)}) and {u.data.links} link{u.data.links === 1 ? '' : 's'}.
        The whole database uses {mb(u.data.db_bytes)} of the 512 MB on Neon’s free plan.
      </p>
      <div className="bar-track" aria-label={`${Math.round(pct)}% of the free plan used`}><div className="bar-fill" style={{ width: `${pct}%`, background: pct > 80 ? 'var(--red-ink)' : 'var(--series-1)' }} /></div>
      <p className="muted small" style={{ margin: 0 }}>Files go in the database (up to 10 MB each). For large files, use Google Drive links, which take no space.</p>
    </>
  )
}

function DataTab() {
  const { user } = useSession()
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState('')
  const allowed = can(user, 'export_data')
  return (
    <>
    {can(user, 'manage_settings') && <DemoCard />}
    <div className="cols">
      <section className="card col-main" aria-label="CSV export">
        <h2>CSV export</h2>
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {done && <Banner onClose={() => setDone('')}>{done} downloaded.</Banner>}
        {!allowed && <Banner kind="warn">CSV export needs the “Export CSV” permission.</Banner>}
        <div className="row">
          {EXPORTS.map(([entity, label]) => (
            <button key={entity} type="button" className="btn" disabled={!allowed}
              onClick={() => downloadCsv(entity).then(() => setDone(label)).catch((e: ApiError) => setError(e))}>Export {label}</button>
          ))}
        </div>
        <span className="muted small">Each file includes owner emails and every field, so it doubles as a manual backup.</span>
      </section>
      <section className="card col-side" aria-label="Backup and audit">
        <h2>Backup &amp; recovery</h2>
        <p className="muted small" style={{ margin: 0 }}>The database runs on Neon (PostgreSQL), which keeps a restore window for point-in-time recovery; its length depends on the Neon plan. Take a weekly CSV export as well until the pilot ends.</p>
        <p className="muted small" style={{ margin: 0 }}>Restore: in the Neon console, restore the branch to a point in time (or to a new branch), then point <span className="mono">CRM_DATABASE_URL</span> on Render at it.</p>
        <StorageUsage />
        <h2>History &amp; audit</h2>
        <p className="muted small" style={{ margin: 0 }}>Kept for every record: stage changes, nurture on/off, risk rating, owner, value, close date, conversions from prospect to opportunity, and who made each change.</p>
      </section>
    </div>
    </>
  )
}

function LaunchTab() {
  const { user } = useSession()
  const allowed = can(user, 'team_view')
  const { data, error, reload } = useLoad(() => api<ChecklistItem[]>('/settings/checklist'), [])
  const [saveError, setSaveError] = useState<ApiError | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  // Ticks show at once; a failed save puts the box back.
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const patch = (key: string, body: { done?: boolean; note?: string }) => {
    if (body.done !== undefined) setTicks((t) => ({ ...t, [key]: body.done as boolean }))
    return api(`/settings/checklist/${key}`, { method: 'PATCH', body }).then(() => reload())
      .catch((e: ApiError) => setSaveError(e))
      .finally(() => setTicks((t) => { const { [key]: _, ...rest } = t; return rest }))
  }
  const group = (title: string, kind: ChecklistItem['kind'], doneWord: string) => {
    const items = (data || []).filter((i) => i.kind === kind).map((i) => (i.key in ticks ? { ...i, done: ticks[i.key] } : i))
    return (
      <section className="card" aria-label={title}>
        <div className="card-head"><h2>{title}</h2><span className="muted small">{items.filter((i) => i.done).length} of {items.length} {doneWord}</span></div>
        <div>
          {items.map((i) => (
            <div className="list-row" key={i.key} style={{ alignItems: 'flex-start' }}>
              <label className="check" style={{ flex: '1 1 280px', alignItems: 'flex-start' }}>
                <input type="checkbox" checked={i.done} disabled={!allowed} onChange={(e) => void patch(i.key, { done: e.target.checked })} />
                <span><strong>{i.name}</strong><br /><span className="muted small">{i.detail}</span>
                  {i.updated_by && <><br /><span className="muted small">{i.done ? 'Ticked' : 'Updated'} by {i.updated_by} · {fmtDateTime(i.updated_at)}</span></>}
                  {i.note && <><br /><span className="small">Note: {i.note}</span></>}
                </span>
              </label>
              {allowed && (
                <span className="row" style={{ gap: 6 }}>
                  <input className="input" style={{ width: 180 }} aria-label={`Note for ${i.name}`} placeholder="Add a note" value={notes[i.key] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [i.key]: e.target.value })} />
                  <button type="button" className="btn" disabled={!(notes[i.key] || '').trim()}
                    onClick={() => void patch(i.key, { note: notes[i.key] }).then(() => setNotes({ ...notes, [i.key]: '' }))}>Save note</button>
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
    )
  }
  return (
    <>
      <ErrorBanner error={error || saveError} onClose={() => setSaveError(null)} />
      {!allowed && <Banner kind="warn">Managers and admins sign off the launch checklist; everyone can see it.</Banner>}
      <div className="cols">
        <div className="col-main">{group('Decisions to confirm (§10)', 'decision', 'confirmed')}</div>
        <div className="col-main">{group('Pilot acceptance tests (§9)', 'test', 'passed')}</div>
      </div>
    </>
  )
}

function LogTab() {
  const { data, error } = useLoad(() => api<SettingsChange[]>('/settings/changes'), [])
  return (
    <section className="card" aria-label="Settings change log">
      <h2>Settings change log</h2>
      <ErrorBanner error={error} />
      {(data || []).length === 0 && <p className="muted" style={{ margin: 0 }}>No settings changed yet.</p>}
      <div>
        {(data || []).map((c, i) => (
          <div className="list-row" key={i}>
            <span style={{ flex: '1 1 320px' }}><strong>{c.area}</strong><br /><span className="small">{c.summary}</span></span>
            <span className="muted small">{c.changed_by || '—'} · {fmtDateTime(c.changed_at)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>('lists')
  const settings = useLoad(() => api<SettingsView>('/settings'), [])
  const [view, setView] = useState<SettingsView | null>(null)
  const current = view || settings.data
  const needsView = tab === 'lists' || tab === 'reminders'
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Controlled lists keep reporting clean; changes here apply to every record. Admins edit lists, stages and reminders; every change is logged.</p>
        </div>
      </div>
      <Tabs<Tab> label="Settings sections" value={tab} onChange={setTab} tabs={[
        { value: 'lists', label: 'Controlled lists' }, { value: 'reminders', label: 'Reminders' }, { value: 'roles', label: 'People & access' },
        { value: 'integrations', label: 'Google integrations' }, { value: 'slack', label: 'Slack' }, { value: 'data', label: 'Export & backup' }, { value: 'launch', label: 'Launch checklist' },
        { value: 'log', label: 'Change log' },
      ]} />
      {needsView && <ErrorBanner error={settings.error} />}
      {needsView && !current && !settings.error && <div className="loading" data-label="Loading settings…">Loading settings…</div>}
      {tab === 'lists' && current && <ListsTab view={current} onView={setView} />}
      {tab === 'reminders' && current && <RemindersTab view={current} onView={setView} />}
      {tab === 'roles' && <PeopleAccess />}
      {tab === 'slack' && <SlackSettings />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'launch' && <LaunchTab />}
      {tab === 'log' && <LogTab />}
    </>
  )
}
