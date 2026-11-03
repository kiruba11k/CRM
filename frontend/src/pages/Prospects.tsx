// §7 My Prospects: filter by status, geography, source and next action.
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Avatar, SortTh, useSort } from '../theme'
import { ApiError, api, downloadCsv } from '../api'
import { fmtDate, nextActionLabel, todayIso } from '../format'
import { useSession } from '../session'
import type { Prospect } from '../types'
import { BulkBar, RowBox, SelectAllBox, useSelection } from '../components/Bulk'
import SavedViews from '../components/SavedViews'
import type { SortDir } from '../theme'
import { CountUp, ErrorBanner, SelectField, StatusPill, Tabs, TextField, useLoad } from '../ui'

type Scope = 'mine' | 'all' | 'unlinked'
interface Filters { status: string | null; country: string | null; source: string | null; next_action: string | null; q: string }
type ViewState = Filters & { scope: Scope; sort_key: string; sort_dir: SortDir }
const DEFAULT_VIEW: ViewState = { scope: 'mine', status: null, country: null, source: null, next_action: null, q: '', sort_key: 'due', sort_dir: 'asc' }

export default function Prospects() {
  const { lists } = useSession()
  const [scope, setScope] = useState<Scope>('mine')
  const [f, setF] = useState<Filters>({ status: null, country: null, source: null, next_action: null, q: '' })
  const [exportError, setExportError] = useState<ApiError | null>(null)
  const { data, error, loading, reload } = useLoad(() => api<Prospect[]>('/prospects', { params: { scope } }), [scope])
  const today = todayIso()

  const rows = useMemo(() => data || [], [data])
  const filtered = useMemo(() => rows.filter((p) =>
    (!f.status || p.status === f.status) && (!f.country || p.geography === f.country) && (!f.source || p.source === f.source)
    && (!f.next_action || p.next_action_code === f.next_action)
    && (!f.q || `${p.full_name} ${p.email || ''} ${p.account_name || ''}`.toLowerCase().includes(f.q.toLowerCase()))), [rows, f])
  const countries = [...new Set(rows.map((p) => p.geography).filter((g): g is string => !!g))].sort()
  const navigate = useNavigate()
  const { sorted, sort, by, setSort } = useSort(filtered, { key: 'due', dir: 'asc' }, {
    name: (p) => p.full_name, account: (p) => p.account_name, status: (p) => lists.prospect_statuses.indexOf(p.status),
    source: (p) => p.source, geo: (p) => p.geography, owner: (p) => p.owner_name, due: (p) => p.next_action_due,
  })
  const sel = useSelection(useMemo(() => sorted.map((p) => p.id), [sorted]))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Prospects</h1>
          <p>People you may contact or are engaging. A prospect can exist before any opportunity. Create one only when a specific piece of business can be tracked.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/cleanup?tab=duplicates">Find duplicates</Link>
          <Link className="btn" to="/import?entity=prospects">Import CSV</Link>
          <button type="button" className="btn" onClick={() => downloadCsv('prospects').catch((e: ApiError) => setExportError(e))}>Export CSV</button>
        </div>
      </div>
      <ErrorBanner error={exportError} onClose={() => setExportError(null)} />

      <section className="tiles" aria-label="Prospect funnel">
        {lists.prospect_statuses.map((s) => (
          <button key={s} type="button" className="tile" aria-pressed={f.status === s}
            style={{ textAlign: 'left', cursor: 'pointer', borderColor: f.status === s ? 'var(--ink)' : undefined }}
            onClick={() => setF({ ...f, status: f.status === s ? null : s })}>
            <span className="k"><StatusPill status={s} /></span>
            <span className="v"><CountUp value={rows.filter((p) => p.status === s).length} /></span>
          </button>
        ))}
      </section>

      <SavedViews<ViewState> page="prospects" defaults={DEFAULT_VIEW}
        value={{ scope, ...f, sort_key: sort.key, sort_dir: sort.dir }}
        onApply={({ scope: sc, sort_key, sort_dir, ...rest }) => { setScope(sc); setF(rest); setSort({ key: sort_key, dir: sort_dir }) }} />

      <Tabs<Scope> label="Whose prospects" value={scope} onChange={setScope}
        tabs={[{ value: 'mine', label: 'My prospects' }, { value: 'all', label: 'All prospects' }, { value: 'unlinked', label: 'No account yet' }]} />

      <div className="grid-fields" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        <TextField label="Search" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Name, email, account" />
        <SelectField label="Status" value={f.status} onChange={(status) => setF({ ...f, status })} options={lists.prospect_statuses} placeholder="All statuses" />
        <SelectField label="Geography" value={f.country} onChange={(country) => setF({ ...f, country })} options={countries} placeholder="All countries" />
        <SelectField label="Source" value={f.source} onChange={(source) => setF({ ...f, source })} options={[...lists.sources, ...lists.retired.sources]} placeholder="All sources" />
        <SelectField label="Next action" value={f.next_action} onChange={(next_action) => setF({ ...f, next_action })} placeholder="All next actions"
          options={lists.next_actions.map((n) => ({ value: n.code, label: n.label }))} />
      </div>

      <ErrorBanner error={error} />
      {loading && !data ? <div className="loading" data-label="Loading prospects…">Loading prospects…</div> : (
        <div className="table-wrap">
          <table style={{ minWidth: 1000 }}>
            <thead><tr>
              <SelectAllBox sel={sel} label="prospects shown" />
              <SortTh label="Name" k="name" sort={sort} by={by} /><SortTh label="Account" k="account" sort={sort} by={by} />
              <SortTh label="Status" k="status" sort={sort} by={by} /><SortTh label="Source" k="source" sort={sort} by={by} />
              <SortTh label="Geography" k="geo" sort={sort} by={by} /><SortTh label="Owner" k="owner" sort={sort} by={by} />
              <SortTh label="Next action · due" k="due" sort={sort} by={by} />
            </tr></thead>
            <tbody>
              {sorted.map((p) => {
                const closed = p.status === 'Disqualified'
                const overdue = !closed && !!p.next_action_due && p.next_action_due < today
                return (
                  <tr key={p.id} className={`row-link${sel.has(p.id) ? ' row-selected' : ''}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) navigate(`/prospects/${p.id}`) }}>
                    <RowBox sel={sel} id={p.id} label={p.full_name} />
                    <td><Link to={`/prospects/${p.id}`} style={{ fontWeight: 600 }}>{p.full_name}</Link><div className="sub">{p.job_title}</div></td>
                    <td>{p.account_id ? <Link to={`/accounts/${p.account_id}`}>{p.account_name}</Link> : <span className="pill pill-amber">Unlinked</span>}</td>
                    <td><StatusPill status={p.status} /></td>
                    <td className="muted">{p.source || '—'}</td>
                    <td className="muted">{p.geography || '—'}</td>
                    <td className="muted">{p.owner_name ? <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar name={p.owner_name} size={26} />{p.owner_name}</span> : '—'}</td>
                    <td>
                      <div>{closed ? 'None (closed)' : nextActionLabel(lists, p.next_action_code, p.next_action_other)}</div>
                      <div className="sub" style={{ color: overdue ? 'var(--red-ink)' : undefined, fontWeight: overdue ? 700 : 400 }}>
                        {closed ? 'No reminders' : `${fmtDate(p.next_action_due)}${overdue ? ' · overdue' : ''}`}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty">No prospects match. Use “+ Prospect” to add one.</div>}
        </div>
      )}
      <BulkBar entity="prospects" sel={sel} onDone={() => void reload()} />
    </>
  )
}
