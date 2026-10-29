// §8 Settings: controlled lists and stage probabilities, reminders, users
// & roles, Google integrations, export & backup, the shared launch
// checklist (§9, §10) and a log of every settings change.
import { useEffect, useState } from 'react'
import { ApiError, api, downloadCsv } from '../api'
import { fmtDateTime } from '../format'
import { useSession } from '../session'
import type { CalendarStatus, ChecklistItem, EditableList, ReminderSettings, Role, SettingsChange, SettingsView, User } from '../types'
import { Banner, ErrorBanner, Tabs, TextField, useLoad } from '../ui'

type Tab = 'lists' | 'reminders' | 'roles' | 'integrations' | 'data' | 'launch' | 'log'
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
  const act = useSettingsAction(onView)
  const values = list.options.map((o) => o.value)
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
          <div className="list-row" key={o.value} style={{ opacity: o.active ? 1 : 0.65 }}>
            {renaming?.from === o.value ? (
              <span className="row" style={{ flex: '1 1 260px' }}>
                <input className="input" aria-label={`New name for ${o.value}`} value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })} />
                <button type="button" className="btn btn-dark" disabled={act.busy}
                  onClick={() => void act.run(`/settings/lists/${listKey}`, 'PATCH', { value: o.value, rename_to: renaming.to }).then((ok) => ok && setRenaming(null))}>Save</button>
                <button type="button" className="btn" onClick={() => setRenaming(null)}>Cancel</button>
              </span>
            ) : (
              <span style={{ flex: '1 1 260px' }}>
                <span className="mono muted">{String(i + 1).padStart(2, '0')}</span>&nbsp;&nbsp;{o.value}
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
          <span className="muted small">Renaming updates every record that uses the option. Retiring hides it from dropdowns; records that already use it keep it.</span>
        </>
      ) : <span className="muted small">Only admins change controlled lists.</span>}
    </section>
  )
}

function ListsTab({ view, onView }: { view: SettingsView; onView: (v: SettingsView) => void }) {
  const { user } = useSession()
  const admin = user.role === 'admin'
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

function RemindersTab({ view, onView }: { view: SettingsView; onView: (v: SettingsView) => void }) {
  const { user } = useSession()
  const admin = user.role === 'admin'
  const act = useSettingsAction(onView)
  // Show the change at once; fall back to the saved values if it fails.
  const [r, setR] = useState<ReminderSettings>(view.reminders)
  useEffect(() => setR(view.reminders), [view.reminders])
  const set = (patch: Partial<ReminderSettings>) => {
    setR((cur) => ({ ...cur, ...patch }))
    void act.run('/settings/reminders', 'PUT', patch).then((ok) => { if (!ok) setR(view.reminders) })
  }
  return (
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
  )
}

const PERMS: [string, boolean, boolean, boolean][] = [
  ['See all accounts, prospects and opportunities (shared pipeline)', true, true, true],
  ['Edit records assigned to them', true, true, true],
  ['Edit anyone’s records / reassign owners', false, true, true],
  ['Be added to proposal & database-build teams', true, true, true],
  ['Manage stages, lists and reminder defaults', false, false, true],
  ['Export CSV', false, true, true],
  ['Manage users and roles', false, false, true],
]
const ROLE_LABEL: Record<Role, string> = { salesperson: 'Salesperson', manager: 'Manager', admin: 'Admin' }

function RolesTab() {
  const { user, lists, refreshUsers } = useSession()
  const admin = user.role === 'admin'
  const { data, error, reload } = useLoad(() => api<User[]>('/users'), [])
  const [saveError, setSaveError] = useState<ApiError | null>(null)
  const [msg, setMsg] = useState('')

  async function patch(u: User, body: Partial<Pick<User, 'role' | 'active'>>) {
    setSaveError(null)
    setMsg('')
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body })
      setMsg(`${u.name} updated.`)
      await Promise.all([reload(), refreshUsers()])
    } catch (e) { setSaveError(e as ApiError) }
  }

  const tick = (on: boolean) => <span style={{ color: on ? 'var(--teal-ink)' : '#8A959C', fontWeight: 700 }}>{on ? '✓ Yes' : '— No'}</span>
  return (
    <>
      <section className="card" aria-label="Access model">
        <div className="card-head"><h2>Access model</h2><span className="pill pill-amber">Confirm before production (§8.1)</span></div>
        <div className="table-wrap">
          <table style={{ minWidth: 620 }}>
            <thead><tr><th>Permission</th><th>Salesperson</th><th>Manager</th><th>Admin</th></tr></thead>
            <tbody>{PERMS.map(([name, s, m, a]) => <tr key={name}><td>{name}</td><td>{tick(s)}</td><td>{tick(m)}</td><td>{tick(a)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-label="Users">
        <div className="card-head"><h2>Users</h2><span className="muted small">People join by signing in with their leadstrategus.com Google account. Admin emails are set on the server.</span></div>
        <ErrorBanner error={error || saveError} onClose={() => setSaveError(null)} />
        {msg && <Banner onClose={() => setMsg('')}>{msg}</Banner>}
        {!admin && <Banner kind="warn">Only admins can change roles or deactivate users.</Banner>}
        <div className="table-wrap">
          <table style={{ minWidth: 620 }}>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {(data || []).map((u) => {
                const self = u.id === user.id
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.name}{self && <span className="muted small"> (you)</span>}</td>
                    <td className="muted">{u.email}</td>
                    <td>
                      {admin && !self ? (
                        <select className="input" aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => void patch(u, { role: e.target.value as Role })}>
                          {lists.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      ) : ROLE_LABEL[u.role]}
                    </td>
                    <td>
                      {admin && !self ? (
                        <button type="button" className="btn" onClick={() => void patch(u, { active: u.active === false })}>
                          {u.active === false ? 'Reactivate' : 'Deactivate'}
                        </button>
                      ) : <span className={`pill pill-${u.active === false ? 'grey' : 'teal'}`}>{u.active === false ? 'Inactive' : 'Active'}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <span className="muted small">You can’t change your own role or deactivate yourself, so there is always an admin.</span>
      </section>
    </>
  )
}

const INTEGRATIONS: [string, string, string, keyof typeof INTEG_STATE][] = [
  ['Google sign-in (Workspace)', 'Priority 1', 'Only leadstrategus.com accounts can sign in. The Google app is set to Internal.', 'live'],
  ['Gmail: contextual links', 'Priority 2', 'Search and compose links on accounts, prospects and opportunities. No mail is copied into the CRM.', 'live'],
  ['HubSpot import', 'Pilot', 'Read-only private-app token on the server (CRM_HUBSPOT_TOKEN). Re-runnable; never overwrites records edited in the CRM.', 'live'],
  ['Google Calendar + Meet', 'Priority 1', 'Create, update and cancel meetings in each person’s own calendar with a Meet link. Per-user sign-in, event ID stored to prevent duplicates, sync status and retry shown. Booking links use Google appointment schedules (free/busy).', 'calendar'],
  ['Gmail: thread association', 'Later, if useful', 'Link a specific thread to a record, storing only the thread ID and minimal metadata.', 'later'],
  ['Google Tasks', 'Optional', 'Mirror next actions into Google Tasks. Deferred unless it proves worth the extra sign-in work.', 'later'],
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

function DataTab() {
  const { user } = useSession()
  const [error, setError] = useState<ApiError | null>(null)
  const [done, setDone] = useState('')
  const can = user.role !== 'salesperson'
  return (
    <div className="cols">
      <section className="card col-main" aria-label="CSV export">
        <h2>CSV export</h2>
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {done && <Banner onClose={() => setDone('')}>{done} downloaded.</Banner>}
        {!can && <Banner kind="warn">CSV export is for managers and admins.</Banner>}
        <div className="row">
          {EXPORTS.map(([entity, label]) => (
            <button key={entity} type="button" className="btn" disabled={!can}
              onClick={() => downloadCsv(entity).then(() => setDone(label)).catch((e: ApiError) => setError(e))}>Export {label}</button>
          ))}
        </div>
        <span className="muted small">Each file includes owner emails and every field, so it doubles as a manual backup.</span>
      </section>
      <section className="card col-side" aria-label="Backup and audit">
        <h2>Backup &amp; recovery</h2>
        <p className="muted small" style={{ margin: 0 }}>The database runs on Neon (PostgreSQL), which keeps a restore window for point-in-time recovery; its length depends on the Neon plan. Take a weekly CSV export as well until the pilot ends.</p>
        <p className="muted small" style={{ margin: 0 }}>Restore: in the Neon console, restore the branch to a point in time (or to a new branch), then point <span className="mono">CRM_DATABASE_URL</span> on Render at it.</p>
        <h2>History &amp; audit</h2>
        <p className="muted small" style={{ margin: 0 }}>Kept for every record: stage changes, nurture on/off, risk rating, owner, value, close date, conversions from prospect to opportunity, and who made each change.</p>
      </section>
    </div>
  )
}

function LaunchTab() {
  const { user } = useSession()
  const can = user.role !== 'salesperson'
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
                <input type="checkbox" checked={i.done} disabled={!can} onChange={(e) => void patch(i.key, { done: e.target.checked })} />
                <span><strong>{i.name}</strong><br /><span className="muted small">{i.detail}</span>
                  {i.updated_by && <><br /><span className="muted small">{i.done ? 'Ticked' : 'Updated'} by {i.updated_by} · {fmtDateTime(i.updated_at)}</span></>}
                  {i.note && <><br /><span className="small">Note: {i.note}</span></>}
                </span>
              </label>
              {can && (
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
      {!can && <Banner kind="warn">Managers and admins sign off the launch checklist; everyone can see it.</Banner>}
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
        { value: 'lists', label: 'Controlled lists' }, { value: 'reminders', label: 'Reminders' }, { value: 'roles', label: 'Users & roles' },
        { value: 'integrations', label: 'Google integrations' }, { value: 'data', label: 'Export & backup' }, { value: 'launch', label: 'Launch checklist' },
        { value: 'log', label: 'Change log' },
      ]} />
      {needsView && <ErrorBanner error={settings.error} />}
      {needsView && !current && !settings.error && <div className="loading">Loading settings…</div>}
      {tab === 'lists' && current && <ListsTab view={current} onView={setView} />}
      {tab === 'reminders' && current && <RemindersTab view={current} onView={setView} />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'launch' && <LaunchTab />}
      {tab === 'log' && <LogTab />}
    </>
  )
}
