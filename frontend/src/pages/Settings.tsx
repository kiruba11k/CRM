// §8 Settings: controlled lists, reminders, users & roles, Google
// integrations, export & backup, and the launch checklist (§9, §10).
// Users & roles and CSV export are live; list editing, reminder toggles and
// a shared launch checklist arrive with the Phase 5 backend.
import { useState } from 'react'
import { ApiError, api, downloadCsv } from '../api'
import { useSession } from '../session'
import type { Lists, Role, User } from '../types'
import { Banner, ErrorBanner, Tabs, useLoad } from '../ui'

type Tab = 'lists' | 'reminders' | 'roles' | 'integrations' | 'data' | 'launch'
type Tag = 'required' | 'confirm' | 'configurable'

const TAG: Record<Tag, { label: string; pill: string }> = {
  required: { label: 'Required v2 rule', pill: 'paper' },
  confirm: { label: 'Confirm before production', pill: 'amber' },
  configurable: { label: 'Configurable', pill: 'teal' },
}

interface ListDef { name: string; tag: Tag; note: string; items: { code: string; label: string; extra?: string }[] }

const numbered = (arr: string[]) => arr.map((label, i) => ({ code: String(i + 1).padStart(2, '0'), label }))

function listDefs(l: Lists): ListDef[] {
  return [
    { name: 'Next actions', tag: 'required', note: `Shared by prospects and opportunities. Free text only through “Other”, which needs a description of ${l.other_max_length} characters or fewer, stored in a separate field.`,
      items: l.next_actions.map((n) => ({ code: n.code, label: n.label, extra: n.code === l.other_code ? `max ${l.other_max_length} chars` : undefined })) },
    { name: 'Opportunity stages', tag: 'confirm', note: 'Starter probabilities. Recalibrate from real conversion data after the pilot. Weighted = estimated value × probability.',
      items: l.stages.map((s, i) => ({ code: String(i + 1).padStart(2, '0'), label: s.name, extra: `${s.probability}%` })) },
    { name: 'Prospect statuses', tag: 'confirm', note: 'Separate from the opportunity flag “Put on Nurture?”: prospects and opportunities have different lifecycles.', items: numbered(l.prospect_statuses) },
    { name: 'Nurture reasons', tag: 'configurable', note: 'Required when Put on Nurture = Yes.', items: numbered(l.nurture_reasons) },
    { name: 'Lost reasons', tag: 'configurable', note: 'Required when an opportunity is marked Lost. Optional notes go in a separate field.', items: numbered(l.lost_reasons) },
    { name: 'Service lines', tag: 'confirm', note: 'Spec examples. Confirm the exact services before launch.', items: numbered(l.service_lines) },
    { name: 'Sources', tag: 'configurable', note: 'Used for prospects and deal source.', items: numbered(l.sources) },
    { name: 'Account statuses', tag: 'configurable', note: '', items: numbered(l.account_statuses) },
    { name: 'Risk ratings', tag: 'required', note: 'Qualified and later need a rating; High needs a reason and a mitigation.', items: numbered(l.risk_ratings) },
    { name: 'Currencies & FX', tag: 'confirm', note: 'Multi-currency is on. Unlike currencies are never summed until an FX rule is agreed.',
      items: l.currencies.map((c, i) => ({ code: c, label: c, extra: i === 0 ? 'base' : 'no FX rule' })) },
  ]
}

function ListsTab() {
  const { lists } = useSession()
  const defs = listDefs(lists)
  const [sel, setSel] = useState(0)
  const cur = defs[sel]
  return (
    <div className="cols">
      <div className="card col-side" style={{ flexBasis: 240 }}>
        <div className="side-list" role="group" aria-label="Lists">
          {defs.map((d, i) => (
            <button key={d.name} type="button" aria-pressed={sel === i} onClick={() => setSel(i)}>
              <span>{d.name}</span><span className="muted small">{d.items.length}</span>
            </button>
          ))}
        </div>
      </div>
      <section className="card col-main" aria-label={cur.name}>
        <div className="card-head"><h2>{cur.name}</h2><span className={`pill pill-${TAG[cur.tag].pill}`}>{TAG[cur.tag].label}</span></div>
        {cur.note && <p className="muted" style={{ margin: 0 }}>{cur.note}</p>}
        <div>
          {cur.items.map((it) => (
            <div className="list-row" key={it.code}>
              <span><span className="mono muted">{it.code}</span>&nbsp;&nbsp;{it.label}</span>
              {it.extra && <span className="pill pill-grey">{it.extra}</span>}
            </div>
          ))}
        </div>
        <Banner kind="warn">These lists are read-only for now: they come from the server and every record is validated against them. Adding and retiring options from this screen arrives with the Settings backend (Phase 5).</Banner>
      </section>
    </div>
  )
}

const REMINDERS: [string, string, string][] = [
  ['Meeting in Calendar', '15-minute reminder before the meeting', 'On (with Calendar sync)'],
  ['Meeting in Calendar (optional)', 'Day-before reminder', 'Off'],
  ['Task / next action due', 'Reminder on the due date', 'On'],
  ['Task / next action due (optional)', 'Reminder one business day before', 'Off'],
  ['Overdue action', 'Shown in My Actions until done, rescheduled or closed', 'On'],
  ['Manager escalation', 'Flag to the manager when an action stays overdue', 'On · after 3 business days'],
  ['Nurture revisit date', 'Reminder on the revisit date; no routine active-deal nudges while nurtured', 'On'],
]

function RemindersTab() {
  return (
    <section className="card" aria-label="Reminder defaults">
      <h2>Reminder defaults (§5)</h2>
      <div>
        {REMINDERS.map(([trigger, behaviour, state]) => (
          <div className="list-row" key={trigger + behaviour}>
            <span><strong>{trigger}</strong><br /><span className="muted small">{behaviour}</span></span>
            <span className={`pill pill-${state.startsWith('Off') ? 'grey' : 'teal'}`}>{state}</span>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>Won, Lost and Disqualified records never get open-record reminders. Nurtured opportunities only get the revisit-date reminder.</p>
      <Banner kind="warn">Defaults are applied by the server today. The escalation threshold is set with the <span className="mono">CRM_ESCALATION_BUSINESS_DAYS</span> setting on Render. Toggling reminders from this screen arrives with the Settings backend (Phase 5).</Banner>
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

const INTEGRATIONS: [string, string, string, 'live' | 'planned' | 'later'][] = [
  ['Google sign-in (Workspace)', 'Priority 1', 'Only leadstrategus.com accounts can sign in. The Google app is set to Internal.', 'live'],
  ['Gmail: contextual links', 'Priority 2', 'Search and compose links on accounts, prospects and opportunities. No mail is copied into the CRM.', 'live'],
  ['HubSpot import', 'Pilot', 'Read-only private-app token on the server (CRM_HUBSPOT_TOKEN). Re-runnable; never overwrites records edited in the CRM.', 'live'],
  ['Google Calendar + Meet', 'Priority 1', 'Create, update and cancel events for meetings and actions. Per-user sign-in, event ID stored to prevent duplicates, sync status and retry shown. Booking links use free/busy.', 'planned'],
  ['Gmail: thread association', 'Later, if useful', 'Link a specific thread to a record, storing only the thread ID and minimal metadata.', 'later'],
  ['Google Tasks', 'Optional', 'Mirror next actions into Google Tasks. Deferred unless it proves worth the extra sign-in work.', 'later'],
]
const INTEG_STATE = { live: ['Live', 'teal'], planned: ['Next: Phase 4', 'amber'], later: ['Deferred', 'grey'] } as const

function IntegrationsTab() {
  return (
    <section className="card" aria-label="Google integrations">
      <h2>Google Workspace integrations</h2>
      <div>
        {INTEGRATIONS.map(([name, priority, desc, state]) => (
          <div className="list-row" key={name}>
            <span style={{ flex: '1 1 320px' }}><strong>{name}</strong> <span className="muted small">· {priority}</span><br /><span className="muted small">{desc}</span></span>
            <span className={`pill pill-${INTEG_STATE[state][1]}`}>{INTEG_STATE[state][0]}</span>
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

const DECISIONS: [string, string][] = [
  ['Build platform', 'Custom build: FastAPI, Neon PostgreSQL, React + TypeScript, Render'],
  ['Number of users', 'Design for a small team; confirm the count'],
  ['Currency', 'Multi-currency with no summing until an FX rule is agreed'],
  ['Access rules', 'Shared visibility, owner editing, manager/admin oversight'],
  ['Geography depth', 'Country required; region/city optional'],
  ['Opportunity stages', 'Starter stages and probabilities from §3'],
  ['Prospect statuses', 'List from §3'],
  ['Google Calendar', 'Implement first'],
  ['Gmail', 'Contextual links first'],
  ['Google Tasks', 'Defer'],
  ['Service-line list', 'Confirm exact services'],
  ['Reminder defaults', 'Start with §5 defaults, adjust after pilot'],
]
const TESTS: [string, string][] = [
  ['Record relationships', 'One account, many contacts and opportunities, no duplicate accounts'],
  ['Prospect lifecycle', 'Statuses move freely; a qualified pursuit becomes an opportunity without losing history'],
  ['Consistent views', 'One update shows in every saved view and report'],
  ['Next Action dropdown', 'Only listed options or Other; same list for prospects and opportunities'],
  ['Other validation', 'Description required, 50 characters max'],
  ['Mandatory follow-up', 'Active prospects and open non-nurtured opportunities need owner, action and due date'],
  ['Risk validation', 'Qualified needs a rating; High needs reason and mitigation'],
  ['Nurture validation', 'Yes needs reason, revisit date and action; stage is kept'],
  ['Nurture reminders/forecast', 'In Nurture Pipeline, out of active forecast, only revisit reminder'],
  ['Closure', 'Won needs value and date; Lost needs reason and date; reminders stop'],
  ['Calendar idempotency', 'Updating an event never duplicates it; failures visible and retryable'],
  ['Permissions', 'Access matches the agreed role model'],
  ['Export / recovery', 'CSV export works; backup and restore documented'],
]
const STORE_KEY = 'ls-crm-launch-checklist'

function loadChecks(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, boolean> } catch { return {} }
}

function LaunchTab() {
  const [checks, setChecks] = useState<Record<string, boolean>>(loadChecks)
  const toggle = (k: string) => setChecks((c) => {
    const next = { ...c, [k]: !c[k] }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* private mode: keep in memory */ }
    return next
  })
  const count = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => checks[`${prefix}${i}`]).filter(Boolean).length
  const group = (title: string, prefix: string, rows: [string, string][], done: string) => (
    <section className="card" aria-label={title}>
      <div className="card-head"><h2>{title}</h2><span className="muted small">{count(prefix, rows.length)} of {rows.length} {done}</span></div>
      <div>
        {rows.map(([name, rec], i) => (
          <label className="list-row check" key={name} style={{ justifyContent: 'flex-start' }}>
            <input type="checkbox" checked={!!checks[`${prefix}${i}`]} onChange={() => toggle(`${prefix}${i}`)} />
            <span><strong>{name}</strong><br /><span className="muted small">{rec}</span></span>
          </label>
        ))}
      </div>
    </section>
  )
  return (
    <>
      <Banner kind="warn">Ticks are saved in this browser only. A shared launch checklist arrives with the Settings backend (Phase 5).</Banner>
      <div className="cols">
        <div className="col-main">{group('Decisions to confirm (§10)', 'd', DECISIONS, 'confirmed')}</div>
        <div className="col-main">{group('Pilot acceptance tests (§9)', 't', TESTS, 'passed')}</div>
      </div>
    </>
  )
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>('lists')
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Controlled lists keep reporting clean; changes here apply to every record.</p>
        </div>
      </div>
      <Tabs<Tab> label="Settings sections" value={tab} onChange={setTab} tabs={[
        { value: 'lists', label: 'Controlled lists' }, { value: 'reminders', label: 'Reminders' }, { value: 'roles', label: 'Users & roles' },
        { value: 'integrations', label: 'Google integrations' }, { value: 'data', label: 'Export & backup' }, { value: 'launch', label: 'Launch checklist' },
      ]} />
      {tab === 'lists' && <ListsTab />}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'launch' && <LaunchTab />}
    </>
  )
}
