// Contacts (every person) and Leads / Prospects (people still being
// qualified) share this page. Each person has one record and a lifecycle
// stage, so the same person is never duplicated between the two:
//   Lead → Qualified lead → Opportunity (open deal) → Customer (won deal),
//   plus Nurture and Disqualified.
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Avatar, SortTh, useSort } from '../theme'
import { ApiError, api, downloadCsv } from '../api'
import { fmtDate, nextActionLabel, todayIso } from '../format'
import { useSession } from '../session'
import type { Prospect } from '../types'
import { BulkBar, RowBox, SelectAllBox, useSelection } from '../components/Bulk'
import { ColumnPicker, useColumns } from '../components/Columns'
import SavedViews from '../components/SavedViews'
import type { SortDir } from '../theme'
import { CountUp, ErrorBanner, SelectField, StatusPill, Tabs, TextField, useLoad } from '../ui'

export const LIFECYCLE = ['Lead', 'Qualified lead', 'Opportunity', 'Customer', 'Nurture', 'Disqualified'] as const
export const LIFECYCLE_PILL: Record<string, string> = { Lead: 'blue', 'Qualified lead': 'teal', Opportunity: 'purple', Customer: 'teal', Nurture: 'amber', Disqualified: 'grey' }
const LEAD_STAGES = ['Lead', 'Qualified lead', 'Nurture']
type Mode = 'contacts' | 'leads'
type Scope = 'mine' | 'all' | 'unlinked'
interface Filters { lifecycle: string | null; status: string | null; owner: string | null; country: string | null; industry: string | null; source: string | null; next_action: string | null; activity: string | null; q: string }
type ViewState = Filters & { scope: Scope; sort_key: string; sort_dir: SortDir }
const EMPTY: Filters = { lifecycle: null, status: null, owner: null, country: null, industry: null, source: null, next_action: null, activity: null, q: '' }
const DEFAULT_VIEW: ViewState = { scope: 'all', ...EMPTY, sort_key: 'due', sort_dir: 'asc' }
const ACTIVITY = [{ value: '7', label: 'Active in the last 7 days' }, { value: '30', label: 'Active in the last 30 days' }, { value: 'quiet30', label: 'No activity for 30+ days' }, { value: 'never', label: 'No activity logged' }]

export function LifecyclePill({ value }: { value?: string | null }) {
  return value ? <span className={`pill pill-${LIFECYCLE_PILL[value] || 'grey'}`}>{value}</span> : null
}

export default function Prospects({ mode = 'contacts' }: { mode?: Mode }) {
  const { lists, users } = useSession()
  const leads = mode === 'leads'
  const [scope, setScope] = useState<Scope>('all')
  const [f, setF] = useState<Filters>(EMPTY)
  const [exportError, setExportError] = useState<ApiError | null>(null)
  const { data, error, loading, reload } = useLoad(() => api<Prospect[]>('/prospects', { params: { scope } }), [scope])
  const today = todayIso()
  const cols = useColumns(mode, [
    { key: 'name', label: 'Name', locked: true }, { key: 'company', label: 'Company' }, { key: 'lifecycle', label: 'Lifecycle stage' },
    { key: 'status', label: 'Lead status', default: leads }, { key: 'email', label: 'Email', default: !leads }, { key: 'phone', label: 'Phone', default: false },
    { key: 'source', label: 'Source', default: leads }, { key: 'industry', label: 'Industry', default: false }, { key: 'geo', label: 'Country' },
    { key: 'owner', label: 'Owner' }, { key: 'activity', label: 'Last activity', default: false }, { key: 'due', label: 'Next action · due' },
  ])

  const base = useMemo(() => (data || []).filter((p) => !leads || LEAD_STAGES.includes(p.lifecycle || 'Lead')), [data, leads])
  const daysSince = (d?: string | null) => (d ? (Date.now() - new Date(d).getTime()) / 86400000 : Infinity)
  const filtered = useMemo(() => base.filter((p) =>
    (!f.lifecycle || p.lifecycle === f.lifecycle) && (!f.status || p.status === f.status) && (!f.owner || p.owner_id === f.owner)
    && (!f.country || p.geography === f.country) && (!f.industry || p.industry === f.industry) && (!f.source || p.source === f.source)
    && (!f.next_action || p.next_action_code === f.next_action)
    && (!f.activity || (f.activity === 'never' ? !p.last_activity : f.activity === 'quiet30' ? daysSince(p.last_activity) >= 30 : daysSince(p.last_activity) <= Number(f.activity)))
    && (!f.q || `${p.full_name} ${p.email || ''} ${p.account_name || ''} ${p.job_title || ''}`.toLowerCase().includes(f.q.toLowerCase()))), [base, f])
  const countries = [...new Set(base.map((p) => p.geography).filter((g): g is string => !!g))].sort()
  const industries = [...new Set(base.map((p) => p.industry).filter((g): g is string => !!g))].sort()
  const navigate = useNavigate()
  const { sorted, sort, by, setSort } = useSort(filtered, { key: 'due', dir: 'asc' }, {
    name: (p) => p.full_name, account: (p) => p.account_name, status: (p) => lists.prospect_statuses.indexOf(p.status),
    lifecycle: (p) => LIFECYCLE.indexOf((p.lifecycle || 'Lead') as typeof LIFECYCLE[number]), email: (p) => p.email,
    source: (p) => p.source, geo: (p) => p.geography, industry: (p) => p.industry, owner: (p) => p.owner_name,
    due: (p) => p.next_action_due, activity: (p) => p.last_activity,
  })
  const sel = useSelection(useMemo(() => sorted.map((p) => p.id), [sorted]))
  const counts = (k: string) => base.filter((p) => (leads ? p.status === k : p.lifecycle === k)).length
  const tiles = leads ? lists.prospect_statuses.filter((s) => s !== 'Disqualified') : [...LIFECYCLE]

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{leads ? 'Leads / Prospects' : 'Contacts'}</h1>
          <p>{leads
            ? 'People being qualified: Lead → Qualified lead. Once there is a specific piece of business, convert them to a deal; they then become an Opportunity contact (and a Customer when it is won).'
            : 'Every person, one record each, with their lifecycle stage. A contact is a person; their company and deals are linked records.'}</p>
        </div>
        <div className="row">
          <Link className="btn" to="/data?tab=duplicates">Find duplicates</Link>
          <Link className="btn" to="/data?tab=import&entity=prospects">Import CSV</Link>
          <button type="button" className="btn" onClick={() => downloadCsv('prospects').catch((e: ApiError) => setExportError(e))}>Export CSV</button>
        </div>
      </div>
      <ErrorBanner error={exportError} onClose={() => setExportError(null)} />

      <section className="tiles" aria-label={leads ? 'Lead status' : 'Lifecycle stages'}>
        {tiles.map((s) => {
          const on = leads ? f.status === s : f.lifecycle === s
          return (
            <button key={s} type="button" className="tile" aria-pressed={on} style={{ textAlign: 'left', cursor: 'pointer', borderColor: on ? 'var(--ink)' : undefined }}
              onClick={() => setF(leads ? { ...f, status: on ? null : s } : { ...f, lifecycle: on ? null : s })}>
              <span className="k">{leads ? <StatusPill status={s} /> : <LifecyclePill value={s} />}</span>
              <span className="v"><CountUp value={counts(s)} /></span>
            </button>
          )
        })}
      </section>

      <SavedViews<ViewState> page="prospects" defaults={DEFAULT_VIEW}
        value={{ scope, ...f, sort_key: sort.key, sort_dir: sort.dir }}
        onApply={({ scope: sc, sort_key, sort_dir, ...rest }) => { setScope(sc); setF({ ...EMPTY, ...rest }); setSort({ key: sort_key, dir: sort_dir }) }} />

      <Tabs<Scope> label="Whose" value={scope} onChange={setScope}
        tabs={[{ value: 'all', label: leads ? 'All leads' : 'All contacts' }, { value: 'mine', label: leads ? 'My leads' : 'My contacts' }, { value: 'unlinked', label: 'No company yet' }]} />

      <div className="grid-fields" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <TextField label="Search" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Name, email, company, title" />
        {!leads && <SelectField label="Lifecycle stage" value={f.lifecycle} onChange={(lifecycle) => setF({ ...f, lifecycle })} options={[...LIFECYCLE]} placeholder="All stages" />}
        {leads && <SelectField label="Lead status" value={f.status} onChange={(status) => setF({ ...f, status })} options={lists.prospect_statuses} placeholder="All statuses" />}
        <SelectField label="Owner" value={f.owner} onChange={(owner) => setF({ ...f, owner })} options={users.filter((u) => u.active !== false).map((u) => ({ value: u.id, label: u.name }))} placeholder="All owners" />
        <SelectField label="Country" value={f.country} onChange={(country) => setF({ ...f, country })} options={countries} placeholder="All countries" />
        <SelectField label="Industry" value={f.industry} onChange={(industry) => setF({ ...f, industry })} options={industries} placeholder="All industries" />
        <SelectField label="Source" value={f.source} onChange={(source) => setF({ ...f, source })} options={[...lists.sources, ...lists.retired.sources]} placeholder="All sources" />
        <SelectField label="Next action" value={f.next_action} onChange={(next_action) => setF({ ...f, next_action })} placeholder="All next actions"
          options={lists.next_actions.map((n) => ({ value: n.code, label: n.label }))} />
        <SelectField label="Activity" value={f.activity} onChange={(activity) => setF({ ...f, activity })} options={ACTIVITY} placeholder="Any activity" />
      </div>
      <div className="list-tools">
        <span className="muted small">{filtered.length} of {base.length} {leads ? 'leads' : 'contacts'}{JSON.stringify(f) !== JSON.stringify(EMPTY) && <> · <button type="button" className="link-btn" onClick={() => setF(EMPTY)}>Clear filters</button></>}</span>
        <ColumnPicker cols={cols} />
      </div>

      <ErrorBanner error={error} />
      {loading && !data ? <div className="loading" data-label="Loading…">Loading…</div> : (
        <div className="table-wrap">
          <table style={{ minWidth: 900 }}>
            <thead><tr>
              <SelectAllBox sel={sel} label="people shown" />
              <SortTh label="Name" k="name" sort={sort} by={by} />
              {cols.has('company') && <SortTh label="Company" k="account" sort={sort} by={by} />}
              {cols.has('lifecycle') && <SortTh label="Lifecycle" k="lifecycle" sort={sort} by={by} />}
              {cols.has('status') && <SortTh label="Lead status" k="status" sort={sort} by={by} />}
              {cols.has('email') && <SortTh label="Email" k="email" sort={sort} by={by} />}
              {cols.has('phone') && <th>Phone</th>}
              {cols.has('source') && <SortTh label="Source" k="source" sort={sort} by={by} />}
              {cols.has('industry') && <SortTh label="Industry" k="industry" sort={sort} by={by} />}
              {cols.has('geo') && <SortTh label="Country" k="geo" sort={sort} by={by} />}
              {cols.has('owner') && <SortTh label="Owner" k="owner" sort={sort} by={by} />}
              {cols.has('activity') && <SortTh label="Last activity" k="activity" sort={sort} by={by} />}
              {cols.has('due') && <SortTh label="Next action · due" k="due" sort={sort} by={by} />}
            </tr></thead>
            <tbody>
              {sorted.map((p) => {
                const closed = p.status === 'Disqualified'
                const overdue = !closed && !!p.next_action_due && p.next_action_due < today
                return (
                  <tr key={p.id} className={`row-link${sel.has(p.id) ? ' row-selected' : ''}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) navigate(`/contacts/${p.id}`) }}>
                    <RowBox sel={sel} id={p.id} label={p.full_name} />
                    <td><Link to={`/contacts/${p.id}`} style={{ fontWeight: 600 }}>{p.full_name}</Link><div className="sub">{p.job_title}</div></td>
                    {cols.has('company') && <td>{p.account_id ? <Link to={`/companies/${p.account_id}`}>{p.account_name}</Link> : <span className="pill pill-amber">No company</span>}</td>}
                    {cols.has('lifecycle') && <td><LifecyclePill value={p.lifecycle} /></td>}
                    {cols.has('status') && <td><StatusPill status={p.status} /></td>}
                    {cols.has('email') && <td className="muted">{p.email || '—'}</td>}
                    {cols.has('phone') && <td className="muted">{p.phone || '—'}</td>}
                    {cols.has('source') && <td className="muted">{p.source || '—'}</td>}
                    {cols.has('industry') && <td className="muted">{p.industry || '—'}</td>}
                    {cols.has('geo') && <td className="muted">{p.geography || '—'}</td>}
                    {cols.has('owner') && <td className="muted">{p.owner_name ? <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar name={p.owner_name} size={26} />{p.owner_name}</span> : '—'}</td>}
                    {cols.has('activity') && <td className="muted">{p.last_activity ? fmtDate(p.last_activity) : 'None'}</td>}
                    {cols.has('due') && <td>
                      <div>{closed ? 'None (closed)' : nextActionLabel(lists, p.next_action_code, p.next_action_other)}</div>
                      <div className="sub" style={{ color: overdue ? 'var(--red-ink)' : undefined, fontWeight: overdue ? 700 : 400 }}>
                        {closed ? 'No reminders' : `${fmtDate(p.next_action_due)}${overdue ? ' · overdue' : ''}`}
                      </div>
                    </td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty">No one matches. Use “+ Contact” to add someone.</div>}
        </div>
      )}
      <BulkBar entity="prospects" sel={sel} onDone={() => void reload()} />
    </>
  )
}
