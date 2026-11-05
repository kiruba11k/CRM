import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Avatar, SortTh, useSort } from '../theme'
import { fmtDate } from '../format'
import { ColumnPicker, useColumns } from '../components/Columns'
import { ApiError, api, downloadCsv } from '../api'
import { useSession } from '../session'
import type { Account } from '../types'
import { BulkBar, RowBox, SelectAllBox, useSelection } from '../components/Bulk'
import SavedViews from '../components/SavedViews'
import { showValue, useCustomColumns } from '../components/CustomFields'
import { ListFilter } from '../components/RecordLists'
import type { SortDir } from '../theme'
import { ErrorBanner, SelectField, Tabs, TextField, useLoad } from '../ui'

type ViewState = { status: string; country: string | null; q: string; owner?: string | null; industry?: string | null; activity?: string | null; sort_key: string; sort_dir: SortDir }
const DEFAULT_VIEW: ViewState = { status: 'all', country: null, q: '', owner: null, industry: null, activity: null, sort_key: 'name', sort_dir: 'asc' }
const ACTIVITY = [{ value: '30', label: 'Active in the last 30 days' }, { value: 'quiet30', label: 'No activity for 30+ days' }, { value: 'quiet90', label: 'No activity for 90+ days' }]
const DAY = 86_400_000
function activityOk(last: string | null | undefined, f: string | null | undefined): boolean {
  if (!f) return true
  const age = last ? (Date.now() - new Date(last).getTime()) / DAY : Infinity
  return f === '30' ? age <= 30 : f === 'quiet30' ? age >= 30 : age >= 90
}

const STATUS_PILL: Record<string, string> = { Target: 'blue', 'Active customer': 'teal', 'Inactive / do not pursue': 'paper' }

export default function Accounts() {
  const { lists, users } = useSession()
  const [status, setStatus] = useState('all')
  const [country, setCountry] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [owner, setOwner] = useState<string | null>(null)
  const [industry, setIndustry] = useState<string | null>(null)
  const [activity, setActivity] = useState<string | null>(null)
  const [listId, setListId] = useState<string | null>(null)
  const [listIds, setListIds] = useState<Set<string> | null>(null)
  const custom = useCustomColumns('accounts')
  const cols = useColumns('companies', [
    { key: 'status', label: 'Status' }, { key: 'country', label: 'Geography' }, { key: 'owner', label: 'Owner' },
    { key: 'prospects', label: 'Contacts' }, { key: 'open', label: 'Open deals' }, { key: 'won', label: 'Won' }, { key: 'last', label: 'Last activity' }, ...custom.defs,
  ])
  const [exportError, setExportError] = useState<ApiError | null>(null)
  const { data, error, loading, reload } = useLoad(() => api<Account[]>('/accounts'), [])
  const rows = useMemo(() => data || [], [data])
  const filtered = useMemo(() => rows.filter((a) => (status === 'all' || a.status === status) && (!country || a.country === country)
    && (!owner || (owner === 'none' ? !a.owner_id : a.owner_id === owner)) && (!industry || a.industry === industry) && activityOk(a.last_activity, activity)
    && (!listIds || listIds.has(a.id))
    && (!q || `${a.name} ${a.industry || ''}`.toLowerCase().includes(q.toLowerCase()))), [rows, status, country, q, owner, industry, activity, listIds])
  const industries = [...new Set(rows.map((a) => a.industry).filter((x): x is string => !!x))].sort()
  const countries = [...new Set(rows.map((a) => a.country))].sort()
  const navigate = useNavigate()
  const { sorted, sort, by, setSort } = useSort(filtered, { key: 'name', dir: 'asc' }, {
    name: (a) => a.name, status: (a) => a.status, country: (a) => a.country, owner: (a) => a.owner_name,
    last: (a) => a.last_activity, prospects: (a) => a.prospect_count ?? 0, open: (a) => a.open_count ?? 0, won: (a) => a.won_count ?? 0,
  })
  const sel = useSelection(useMemo(() => sorted.map((a) => a.id), [sorted]))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Companies</h1>
          <p>One record per company. Each company can have many contacts and many deals.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/data?tab=duplicates">Find duplicates</Link>
          <Link className="btn" to="/data?tab=import&entity=accounts">Import CSV</Link>
          <button type="button" className="btn" onClick={() => downloadCsv('accounts').catch((e: ApiError) => setExportError(e))}>Export CSV</button>
        </div>
      </div>
      <ErrorBanner error={exportError} onClose={() => setExportError(null)} />
      <SavedViews<ViewState> page="accounts" defaults={DEFAULT_VIEW} value={{ status, country, q, owner, industry, activity, sort_key: sort.key, sort_dir: sort.dir }}
        onApply={(v) => { setStatus(v.status); setCountry(v.country); setQ(v.q); setOwner(v.owner ?? null); setIndustry(v.industry ?? null); setActivity(v.activity ?? null); setSort({ key: v.sort_key, dir: v.sort_dir }) }} />
      <Tabs label="Account status" value={status} onChange={setStatus}
        tabs={[{ value: 'all', label: 'All companies', count: rows.length }, ...lists.account_statuses.map((s) => ({ value: s, label: s, count: rows.filter((a) => a.status === s).length }))]} />
      <div className="row-end">
        <div style={{ width: 260 }}><TextField label="Search" value={q} onChange={setQ} placeholder="Name or industry" /></div>
        <div style={{ width: 200 }}><SelectField label="Geography" value={country} onChange={setCountry} options={countries} placeholder="All countries" /></div>
        <div style={{ width: 200 }}><SelectField label="Owner" value={owner} onChange={setOwner} options={[{ value: 'none', label: 'Unassigned' }, ...users.map((u) => ({ value: u.id, label: u.name }))]} placeholder="Anyone" /></div>
        <div style={{ width: 200 }}><SelectField label="Industry" value={industry} onChange={setIndustry} options={industries} placeholder="Any industry" /></div>
        <div style={{ width: 230 }}><SelectField label="Activity" value={activity} onChange={setActivity} options={ACTIVITY} placeholder="Any" /></div>
        <ListFilter entity="accounts" value={listId} onChange={(id, ids) => { setListId(id); setListIds(ids) }} />
        <ColumnPicker cols={cols} />
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <div className="loading" data-label="Loading companies…">Loading companies…</div> : (
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <thead><tr>
              <SelectAllBox sel={sel} label="accounts shown" />
              <SortTh label="Company" k="name" sort={sort} by={by} />
              {cols.has('status') && <SortTh label="Status" k="status" sort={sort} by={by} />}
              {cols.has('country') && <SortTh label="Geography" k="country" sort={sort} by={by} />}
              {cols.has('owner') && <SortTh label="Owner" k="owner" sort={sort} by={by} />}
              {cols.has('prospects') && <SortTh label="Contacts" k="prospects" sort={sort} by={by} num />}
              {cols.has('open') && <SortTh label="Open deals" k="open" sort={sort} by={by} num />}
              {cols.has('won') && <SortTh label="Won" k="won" sort={sort} by={by} num />}
              {cols.has('last') && <SortTh label="Last activity" k="last" sort={sort} by={by} />}
              {custom.fields.filter((cf) => cols.has(`cf_${cf.key}`)).map((cf) => <th key={cf.id}>{cf.label}</th>)}
            </tr></thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.id} className={`row-link${sel.has(a.id) ? ' row-selected' : ''}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) navigate(`/companies/${a.id}`) }}>
                  <RowBox sel={sel} id={a.id} label={a.name} />
                  <td><Link to={`/companies/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link><div className="sub">{a.industry}</div></td>
                  {cols.has('status') && <td><span className={`pill pill-${STATUS_PILL[a.status] || 'grey'}`}>{a.status}</span></td>}
                  {cols.has('country') && <td className="muted">{a.country}{a.region ? ` · ${a.region}` : ''}</td>}
                  {cols.has('owner') && <td className="muted">{a.owner_name ? <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar name={a.owner_name} size={26} />{a.owner_name}</span> : '—'}</td>}
                  {cols.has('prospects') && <td className="num">{a.prospect_count}</td>}
                  {cols.has('open') && <td className="num">{a.open_count}</td>}
                  {cols.has('won') && <td className="num">{a.won_count}</td>}
                  {cols.has('last') && <td className="muted">{a.last_activity ? fmtDate(a.last_activity) : '—'}</td>}
                  {custom.fields.filter((cf) => cols.has(`cf_${cf.key}`)).map((cf) => <td key={cf.id} className="muted">{showValue(cf, custom.values[a.id]?.[cf.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty">No companies match. Use “+ Company” to add one.</div>}
        </div>
      )}
      <BulkBar entity="accounts" sel={sel} onDone={() => void reload()} />
    </>
  )
}
