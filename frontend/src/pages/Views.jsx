// §7 saved views: Active forecast, Nurture pipeline, High-risk deals,
// Proposal planning, Closed deals. All read the same opportunity records.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { fmtDate, money, moneyByCurrency } from '../format.js'
import { ErrorBanner, Tabs, useLoad } from '../ui.jsx'

const VIEWS = {
  forecast: { label: 'Active forecast', desc: 'Open opportunities not on nurture, by expected close period. Unweighted and weighted values are shown separately.' },
  nurture: { label: 'Nurture pipeline', desc: 'Put on Nurture = Yes. They keep their stage, stay out of the active forecast and get one reminder on the revisit date.' },
  risk: { label: 'High-risk deals', desc: 'Open opportunities rated High, with the required reason and mitigation.' },
  proposals: { label: 'Proposal planning', desc: 'Open opportunities with a proposal date, plus who is delivering.' },
  closed: { label: 'Closed deals', desc: 'Won and lost outcomes with actual contract value and loss reasons.' },
}

function Table({ cols, rows }) {
  return (
    <div className="table-wrap">
      <table style={{ minWidth: 900 }}>
        <thead><tr><th>Opportunity</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.o.id}>
              <td><Link to={`/opportunities/${r.o.id}`} style={{ fontWeight: 600 }}>{r.o.name}</Link><div className="sub">{r.o.account_name} · {r.o.owner_name}</div></td>
              {r.cells.map((c, i) => <td key={i}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">Nothing in this view.</div>}
    </div>
  )
}

export default function Views() {
  const [view, setView] = useState('forecast')
  const all = useLoad(() => api('/opportunities', { params: { include_nurtured: true } }), [])
  const forecast = useLoad(() => api('/reports/forecast'), [])
  const opps = all.data || []
  const open = opps.filter((o) => !['Won', 'Lost'].includes(o.stage))
  const lists = {
    forecast: open.filter((o) => !o.on_nurture),
    nurture: open.filter((o) => o.on_nurture),
    risk: open.filter((o) => o.risk_rating === 'High'),
    proposals: open.filter((o) => o.proposal_due && !o.on_nurture),
    closed: opps.filter((o) => ['Won', 'Lost'].includes(o.stage)),
  }
  const by = (list, key) => list.reduce((acc, o) => ({ ...acc, [o.currency]: (acc[o.currency] || 0) + Number(o[key] || 0) }), {})

  let body = null
  if (view === 'forecast') body = <>
    <section className="tiles" aria-label="Forecast by period">
      {(forecast.data || []).map((p) => (
        <div className="tile" key={p.period}><span className="k">{p.period} · {p.count} open</span><span className="v" style={{ fontSize: 16 }}>{moneyByCurrency(p.unweighted)}</span><span className="s">weighted {moneyByCurrency(p.weighted)}</span></div>
      ))}
    </section>
    <Table cols={['Stage', 'Probability', 'Expected close', 'Unweighted', 'Weighted']}
      rows={lists.forecast.map((o) => ({ o, cells: [o.stage, `${o.probability}%`, fmtDate(o.expected_close), money(o.estimated_value, o.currency), money(o.weighted_value, o.currency)] }))} />
  </>
  if (view === 'nurture') body = <>
    <div className="tile" style={{ maxWidth: 360 }}><span className="k">Nurtured value</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(by(lists.nurture, 'estimated_value'))}</span></div>
    <Table cols={['Stage (kept)', 'Value', 'Reason', 'Revisit date']}
      rows={lists.nurture.map((o) => ({ o, cells: [o.stage, money(o.estimated_value, o.currency), o.nurture_reason, fmtDate(o.nurture_until)] }))} />
  </>
  if (view === 'risk') body = <Table cols={['Stage', 'Risk reason', 'Mitigation', 'Expected close', 'Next action']}
    rows={lists.risk.map((o) => ({ o, cells: [o.stage, o.high_risk_reason, o.risk_mitigation, fmtDate(o.expected_close), o.on_nurture ? 'On nurture' : `${o.next_action_label} · ${fmtDate(o.next_action_due)}`] }))} />
  if (view === 'proposals') body = <Table cols={['Stage', 'Proposal due', 'Delivery lead', 'Effort estimate']}
    rows={lists.proposals.map((o) => ({ o, cells: [o.stage, fmtDate(o.proposal_due), o.delivery_lead || '—', o.effort_estimate || '—'] }))} />
  if (view === 'closed') body = <>
    <section className="tiles">
      <div className="tile"><span className="k">Won · actual value</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(by(lists.closed.filter((o) => o.stage === 'Won'), 'actual_value'))}</span></div>
      <div className="tile"><span className="k">Win rate</span><span className="v">{lists.closed.length ? Math.round(100 * lists.closed.filter((o) => o.stage === 'Won').length / lists.closed.length) : 0}%</span><span className="s">{lists.closed.filter((o) => o.stage === 'Won').length} won ÷ {lists.closed.length} closed (all time)</span></div>
    </section>
    <Table cols={['Outcome', 'Actual value', 'Original estimate', 'Closed', 'Lost reason']}
      rows={lists.closed.map((o) => ({ o, cells: [o.stage, o.stage === 'Won' ? money(o.actual_value, o.currency) : '—', money(o.estimated_value, o.currency), fmtDate(o.won_date || o.lost_date), o.lost_reason ? `${o.lost_reason}${o.lost_notes ? `: ${o.lost_notes}` : ''}` : '—'] }))} />
  </>

  return (
    <>
      <div className="page-head">
        <div><h1>Forecast &amp; saved views</h1><p>{VIEWS[view].desc}</p></div>
      </div>
      <Tabs label="Saved views" value={view} onChange={setView} tabs={Object.entries(VIEWS).map(([value, v]) => ({ value, label: v.label, count: lists[value].length }))} />
      <ErrorBanner error={all.error || forecast.error} />
      {all.loading && !all.data ? <div className="loading">Loading…</div> : body}
    </>
  )
}
