// Deals as a table (CRM review §4.4): search, filters (owner, stage, close
// date, source, industry, value, activity, health), configurable columns,
// saved views, bulk actions and export. The Board is the Pipeline page.
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { fmtDate, money, moneyByCurrency, todayIso, totalsByCurrency } from '../format'
import { useSession } from '../session'
import { Avatar, SortTh, StagePill, useSort, type SortDir } from '../theme'
import type { Opportunity, StaleResponse } from '../types'
import { BulkBar, RowBox, SelectAllBox, useSelection } from '../components/Bulk'
import { ColumnPicker, useColumns } from '../components/Columns'
import DealsToggle from '../components/DealsToggle'
import HealthPill from '../components/HealthPill'
import SavedViews from '../components/SavedViews'
import { ErrorBanner, SelectField, TextField, useLoad } from '../ui'

interface Filters { q: string; status: string; owner: string | null; stage: string | null; close: string | null; source: string | null; industry: string | null; min: string; activity: string | null; health: string | null }
type ViewState = Filters & { sort_key: string; sort_dir: SortDir }
const EMPTY: Filters = { q: '', status: 'open', owner: null, stage: null, close: null, source: null, industry: null, min: '', activity: null, health: null }
const DEFAULT_VIEW: ViewState = { ...EMPTY, sort_key: 'close', sort_dir: 'asc' }
const CLOSE = [{ value: 'overdue', label: 'Close date passed' }, { value: 'month', label: 'This month' }, { value: 'quarter', label: 'This quarter' }, { value: '90', label: 'Next 90 days' }, { value: 'none', label: 'No close date' }]
const ACTIVITY = [{ value: '7', label: 'Active in the last 7 days' }, { value: 'quiet14', label: 'No activity for 14+ days' }, { value: 'quiet30', label: 'No activity for 30+ days' }]
const STATUS = [{ value: 'open', label: 'Open (not nurtured)' }, { value: 'nurture', label: 'On nurture' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }, { value: 'all', label: 'All deals' }]

function csv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }).join(',')).join('\n')
}

export default function Deals() {
  const { lists, users } = useSession()
  const data = useLoad(() => api<Opportunity[]>('/opportunities', { params: { include_nurtured: true } }), [])
  const health = useLoad(() => api<StaleResponse>('/alerts/stale', { params: { scope: 'team' } }), [])
  const hmap = useMemo(() => new Map((health.data?.items || []).map((d) => [d.id, d])), [health.data])
  const [params] = useSearchParams()
  const [f, setF] = useState<Filters>(() => ({ ...EMPTY, health: params.get('health') }))
  const today = todayIso()
  const cols = useColumns('deals', [
    { key: 'name', label: 'Deal', locked: true }, { key: 'company', label: 'Company' }, { key: 'stage', label: 'Stage' },
    { key: 'amount', label: 'Amount' }, { key: 'weighted', label: 'Weighted', default: false }, { key: 'close', label: 'Close date' },
    { key: 'owner', label: 'Owner' }, { key: 'next', label: 'Next action' }, { key: 'health', label: 'Health' }, { key: 'risk', label: 'Risk rating', default: false },
    { key: 'source', label: 'Source', default: false }, { key: 'service', label: 'Service line', default: false }, { key: 'industry', label: 'Industry', default: false },
    { key: 'activity', label: 'Last activity', default: false },
  ])
  const days = (d?: string | null) => (d ? (Date.now() - new Date(d).getTime()) / 86400000 : Infinity)
  const inClose = (o: Opportunity) => {
    const c = o.expected_close
    if (!f.close) return true
    if (f.close === 'none') return !c
    if (!c) return false
    const now = new Date(`${today}T00:00:00`)
    if (f.close === 'overdue') return c < today
    if (f.close === 'month') return c.slice(0, 7) === today.slice(0, 7)
    if (f.close === 'quarter') { const q = (d: string) => `${d.slice(0, 4)}-${Math.floor((Number(d.slice(5, 7)) - 1) / 3)}`; return q(c) === q(today) }
    return c >= today && new Date(`${c}T00:00:00`).getTime() - now.getTime() <= 90 * 86400000
  }
  const rows = useMemo(() => (data.data || []).filter((o) =>
    (f.status === 'all' || (f.status === 'open' && !o.on_nurture && !['Won', 'Lost'].includes(o.stage)) || (f.status === 'nurture' && o.on_nurture)
      || (f.status === 'won' && o.stage === 'Won') || (f.status === 'lost' && o.stage === 'Lost'))
    && (!f.owner || o.owner_id === f.owner) && (!f.stage || o.stage === f.stage) && inClose(o)
    && (!f.source || o.deal_source === f.source) && (!f.industry || o.industry === f.industry)
    && (!f.min || Number(o.estimated_value || 0) >= Number(f.min))
    && (!f.activity || (f.activity === '7' ? days(o.last_activity) <= 7 : days(o.last_activity) >= Number(f.activity.replace('quiet', ''))))
    && (!f.health || (f.health === 'healthy' ? !hmap.has(o.id) : f.health === 'risk' ? hmap.has(o.id) : hmap.get(o.id)?.level === f.health))
    && (!f.q || `${o.name} ${o.account_name || ''} ${o.owner_name || ''}`.toLowerCase().includes(f.q.toLowerCase())),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [data.data, f, hmap, today])
  const order = ['High', 'Medium', 'Low']
  const { sorted, sort, by, setSort } = useSort(rows, { key: 'close', dir: 'asc' }, {
    name: (o) => o.name, company: (o) => o.account_name, stage: (o) => lists.stages.findIndex((s) => s.name === o.stage),
    amount: (o) => Number(o.estimated_value || 0), weighted: (o) => Number(o.weighted_value || 0), close: (o) => o.expected_close,
    owner: (o) => o.owner_name, next: (o) => o.next_action_due, health: (o) => { const h = hmap.get(o.id)?.level; return h ? order.indexOf(h) : 9 },
    risk: (o) => o.risk_rating, source: (o) => o.deal_source, service: (o) => o.service_line, industry: (o) => o.industry, activity: (o) => o.last_activity,
  })
  const sel = useSelection(useMemo(() => sorted.map((o) => o.id), [sorted]))
  const navigate = useNavigate()
  const industries = [...new Set((data.data || []).map((o) => o.industry).filter((x): x is string => !!x))].sort()
  const exportSelected = () => {
    const pick = sorted.filter((o) => sel.has(o.id))
    const text = csv([['Deal', 'Company', 'Stage', 'Amount', 'Currency', 'Weighted', 'Close date', 'Owner', 'Next action', 'Due', 'Health', 'Risk rating', 'Source', 'Service line'],
      ...pick.map((o) => [o.name, o.account_name, o.stage, o.estimated_value, o.currency, o.weighted_value, o.expected_close, o.owner_name, o.next_action_label, o.next_action_due, hmap.get(o.id)?.level || 'Healthy', o.risk_rating, o.deal_source, o.service_line])])
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = `crm-deals-${today}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Deals</h1><p>Every revenue opportunity as a table. Use the board for the visual pipeline.</p></div>
        <div className="row"><DealsToggle /><Link className="btn" to="/data?tab=import&entity=opportunities">Import CSV</Link></div>
      </div>
      <section className="tiles" aria-label="Totals">
        <div className="tile"><span className="k">Deals shown</span><span className="v">{rows.length}</span><span className="s">of {(data.data || []).length}</span></div>
        <div className="tile"><span className="k">Amount</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(totalsByCurrency(rows, (o) => o.estimated_value))}</span><span className="s">unweighted</span></div>
        <div className="tile"><span className="k">Weighted</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(totalsByCurrency(rows, (o) => o.weighted_value))}</span><span className="s">× stage probability</span></div>
        <div className="tile"><span className="k">At risk</span><span className="v" style={{ color: 'var(--red-ink)' }}>{rows.filter((o) => hmap.has(o.id)).length}</span><span className="s">{rows.filter((o) => hmap.get(o.id)?.level === 'High').length} high</span></div>
      </section>
      <SavedViews<ViewState> page="deals" defaults={DEFAULT_VIEW} value={{ ...f, sort_key: sort.key, sort_dir: sort.dir }}
        onApply={({ sort_key, sort_dir, ...rest }) => { setF({ ...EMPTY, ...rest }); setSort({ key: sort_key, dir: sort_dir }) }} />
      <div className="grid-fields" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
        <TextField label="Search" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Deal, company, owner" />
        <SelectField label="Status" value={f.status} onChange={(status) => setF({ ...f, status: status || 'all' })} options={STATUS} />
        <SelectField label="Owner" value={f.owner} onChange={(owner) => setF({ ...f, owner })} options={users.map((u) => ({ value: u.id, label: u.name }))} placeholder="All owners" />
        <SelectField label="Stage" value={f.stage} onChange={(stage) => setF({ ...f, stage })} options={lists.stages.map((s) => s.name)} placeholder="All stages" />
        <SelectField label="Close date" value={f.close} onChange={(close) => setF({ ...f, close })} options={CLOSE} placeholder="Any" />
        <SelectField label="Source" value={f.source} onChange={(source) => setF({ ...f, source })} options={lists.sources} placeholder="All sources" />
        <SelectField label="Industry" value={f.industry} onChange={(industry) => setF({ ...f, industry })} options={industries} placeholder="All industries" />
        <TextField label="Amount at least" value={f.min} onChange={(min) => setF({ ...f, min: min.replace(/[^0-9.]/g, '') })} placeholder="e.g. 10000" />
        <SelectField label="Activity" value={f.activity} onChange={(activity) => setF({ ...f, activity })} options={ACTIVITY} placeholder="Any" />
        <SelectField label="Health" value={f.health} onChange={(health) => setF({ ...f, health })} options={[{ value: 'risk', label: 'Any risk' }, { value: 'High', label: 'High risk' }, { value: 'Medium', label: 'Medium risk' }, { value: 'Low', label: 'Low risk' }, { value: 'healthy', label: 'Healthy' }]} placeholder="Any" />
      </div>
      <div className="list-tools">
        <span className="muted small">{JSON.stringify(f) !== JSON.stringify(EMPTY) ? <button type="button" className="link-btn" onClick={() => setF(EMPTY)}>Clear filters</button> : 'Open deals, soonest close first'}</span>
        <ColumnPicker cols={cols} />
      </div>
      <ErrorBanner error={data.error} />
      {data.loading && !data.data ? <div className="loading" data-label="Loading deals…">Loading deals…</div> : (
        <div className="table-wrap">
          <table style={{ minWidth: 1000 }}>
            <thead><tr>
              <SelectAllBox sel={sel} label="deals shown" />
              <SortTh label="Deal" k="name" sort={sort} by={by} />
              {cols.has('company') && <SortTh label="Company" k="company" sort={sort} by={by} />}
              {cols.has('stage') && <SortTh label="Stage" k="stage" sort={sort} by={by} />}
              {cols.has('amount') && <SortTh label="Amount" k="amount" sort={sort} by={by} num />}
              {cols.has('weighted') && <SortTh label="Weighted" k="weighted" sort={sort} by={by} num />}
              {cols.has('close') && <SortTh label="Close date" k="close" sort={sort} by={by} />}
              {cols.has('owner') && <SortTh label="Owner" k="owner" sort={sort} by={by} />}
              {cols.has('next') && <SortTh label="Next action" k="next" sort={sort} by={by} />}
              {cols.has('health') && <SortTh label="Health" k="health" sort={sort} by={by} />}
              {cols.has('risk') && <SortTh label="Risk rating" k="risk" sort={sort} by={by} />}
              {cols.has('source') && <SortTh label="Source" k="source" sort={sort} by={by} />}
              {cols.has('service') && <SortTh label="Service line" k="service" sort={sort} by={by} />}
              {cols.has('industry') && <SortTh label="Industry" k="industry" sort={sort} by={by} />}
              {cols.has('activity') && <SortTh label="Last activity" k="activity" sort={sort} by={by} />}
            </tr></thead>
            <tbody>{sorted.map((o) => {
              const late = !!o.next_action_due && o.next_action_due < today && !['Won', 'Lost'].includes(o.stage)
              return (
                <tr key={o.id} className={`row-link${sel.has(o.id) ? ' row-selected' : ''}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) navigate(`/opportunities/${o.id}`) }}>
                  <RowBox sel={sel} id={o.id} label={o.name} />
                  <td><Link to={`/opportunities/${o.id}`} style={{ fontWeight: 600 }}>{o.name}</Link>{o.on_nurture && <span className="pill pill-purple" style={{ marginLeft: 6 }}>Nurture</span>}</td>
                  {cols.has('company') && <td><Link to={`/companies/${o.account_id}`}>{o.account_name}</Link></td>}
                  {cols.has('stage') && <td><StagePill stage={o.stage} /></td>}
                  {cols.has('amount') && <td className="num">{money(o.estimated_value, o.currency)}</td>}
                  {cols.has('weighted') && <td className="num">{money(o.weighted_value, o.currency)}</td>}
                  {cols.has('close') && <td style={{ color: o.expected_close && o.expected_close < today && !['Won', 'Lost'].includes(o.stage) ? 'var(--red-ink)' : undefined }}>{fmtDate(o.expected_close)}</td>}
                  {cols.has('owner') && <td className="muted"><span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar name={o.owner_name} size={24} />{o.owner_name}</span></td>}
                  {cols.has('next') && <td><div>{o.next_action_label || '—'}</div><div className="sub" style={{ color: late ? 'var(--red-ink)' : undefined }}>{o.next_action_due ? `${fmtDate(o.next_action_due)}${late ? ' · overdue' : ''}` : ''}</div></td>}
                  {cols.has('health') && <td><HealthPill deal={hmap.get(o.id)} /></td>}
                  {cols.has('risk') && <td className="muted">{o.risk_rating}</td>}
                  {cols.has('source') && <td className="muted">{o.deal_source || '—'}</td>}
                  {cols.has('service') && <td className="muted">{o.service_line || '—'}</td>}
                  {cols.has('industry') && <td className="muted">{o.industry || '—'}</td>}
                  {cols.has('activity') && <td className="muted">{o.last_activity ? fmtDate(o.last_activity) : 'None'}</td>}
                </tr>
              )
            })}</tbody>
          </table>
          {rows.length === 0 && <div className="empty">No deals match.</div>}
        </div>
      )}
      <BulkBar entity="opportunities" sel={sel} onDone={() => { void data.reload(); void health.reload() }} onExport={exportSelected} />
    </>
  )
}
