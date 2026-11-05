// CRM Home: the business overview (CRM review §5). My Actions stays the
// personal to-do page; this one shows how the pipeline and team are doing.
import { Link } from 'react-router-dom'
import { api } from '../api'
import { moneyByCurrency } from '../format'
import { Avatar, stageColor } from '../theme'
import type { CurrencyTotals } from '../types'
import { CountUp, ErrorBanner, useLoad } from '../ui'

interface HomeData {
  open_deals: number; pipeline: CurrencyTotals; weighted: CurrencyTotals
  closing_this_month: { count: number; value: CurrencyTotals }
  new_leads: { week: number; month: number }
  win_rate: { won: number; lost: number; rate: number | null }
  at_risk: number; no_next_action: number
  team: { name: string; open: number; pipeline: CurrencyTotals; overdue: number; no_action: number; at_risk: number; activities_7d: number; won_quarter: CurrencyTotals }[]
  conversion: { stage: string; next: string; reached: number; went_on: number; rate: number | null }[]
}
const num = (o: CurrencyTotals) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, Number(v)]))

export default function Home() {
  const d = useLoad(() => api<HomeData>('/reports/home'), [])
  const h = d.data
  return (
    <>
      <div className="page-head">
        <div><h1>CRM Home</h1><p>How the pipeline and the team are doing today. For your own to-do list, open <Link to="/">My Actions</Link>.</p></div>
      </div>
      <ErrorBanner error={d.error} />
      {!h && d.loading && <div className="loading" data-label="Loading…">Loading…</div>}
      {h && <>
        <section className="tiles" aria-label="Pipeline">
          <Link to="/deals" className="tile tile-link"><span className="k">Open deals · pipeline value</span><span className="v"><CountUp value={h.open_deals} /></span><span className="s">{moneyByCurrency(num(h.pipeline))}</span></Link>
          <Link to="/forecast" className="tile tile-link"><span className="k">Weighted forecast</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(num(h.weighted))}</span><span className="s">Value × stage probability</span></Link>
          <div className="tile"><span className="k">Expected to close this month</span><span className="v"><CountUp value={h.closing_this_month.count} /></span><span className="s">{moneyByCurrency(num(h.closing_this_month.value))}</span></div>
          <Link to="/leads" className="tile tile-link"><span className="k">New leads</span><span className="v"><CountUp value={h.new_leads.week} /></span><span className="s">this week · {h.new_leads.month} this month</span></Link>
          <div className="tile"><span className="k">Win rate (90 days)</span><span className="v">{h.win_rate.rate ?? '—'}{h.win_rate.rate != null ? '%' : ''}</span><span className="s">{h.win_rate.won} won ÷ {h.win_rate.won + h.win_rate.lost} closed</span></div>
          <Link to="/" className="tile tile-link"><span className="k">At-risk deals</span><span className="v" style={{ color: h.at_risk ? 'var(--red-ink)' : undefined }}><CountUp value={h.at_risk} /></span><span className="s">{h.no_next_action} with no next action</span></Link>
        </section>

        <div className="cols">
          <section className="card col-side" aria-label="Stage-to-stage conversion">
            <div className="card-head"><h2>Stage-to-stage conversion</h2><span className="muted small">deals created in the last 12 months</span></div>
            {h.conversion.map((c) => (
              <div className="bar-row" key={c.stage} title={`${c.went_on} of ${c.reached} deals that reached ${c.stage} went on to ${c.next}`}>
                <span className="small">{c.stage} → {c.next}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${c.rate || 0}%`, background: stageColor(c.next) }} /></div>
                <span className="small">{c.rate != null ? `${c.rate}%` : '—'}</span>
              </div>
            ))}
            <span className="muted small">Of the deals that reached a stage, the share that moved further. Hover a row for the counts.</span>
          </section>
          <section className="card col-main" aria-label="Team">
            <div className="card-head"><h2>Team activity and performance</h2><Link to="/reports" className="small">Reports</Link></div>
            <div className="table-wrap">
              <table style={{ minWidth: 900 }}>
                <thead><tr><th>Owner</th><th className="num">Open deals</th><th>Pipeline</th><th className="num">Overdue actions</th><th className="num">No next action</th><th className="num">At risk</th><th className="num">Activities (7 days)</th><th>Won this quarter</th></tr></thead>
                <tbody>{h.team.map((t) => (
                  <tr key={t.name}>
                    <td><span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar name={t.name} size={24} /><strong style={{ whiteSpace: 'nowrap' }}>{t.name}</strong></span></td>
                    <td className="num">{t.open}</td><td>{moneyByCurrency(num(t.pipeline))}</td>
                    <td className="num" style={{ color: t.overdue ? 'var(--red-ink)' : undefined }}>{t.overdue}</td>
                    <td className="num" style={{ color: t.no_action ? 'var(--red-ink)' : undefined }}>{t.no_action}</td>
                    <td className="num">{t.at_risk}</td><td className="num">{t.activities_7d}</td><td>{moneyByCurrency(num(t.won_quarter))}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </div>
      </>}
    </>
  )
}
