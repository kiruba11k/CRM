// §7 Reports & metrics. Every rate shows its numerator, denominator and
// date window; totals stay per currency (§2.3).
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { fmtDate, moneyByCurrency, totalsByCurrency, todayIso } from '../format'
import { useSession } from '../session'
import type { ActionsResponse, Opportunity, PipelineReport, Prospect } from '../types'
import { ErrorBanner, Segmented, Tabs, useLoad } from '../ui'

type Win = '90' | 'quarter' | 'ytd'
type Group = 'sales' | 'geo' | 'service'

const FUNNEL_COLOR: Record<string, string> = { New: '#8A959C', Contacted: '#2E5EAA', Engaged: '#D99000', Qualified: '#0E7C6B', Nurture: '#7A4FB5', Disqualified: '#C93A2B' }
const STAGE_COLOR = ['#8A959C', '#2E5EAA', '#0E7C6B', '#D99000', '#E85D3D', '#7A4FB5', '#5B3B8C']

function windowStart(win: Win, today: string): string {
  const d = new Date(`${today}T00:00:00Z`)
  if (win === '90') d.setUTCDate(d.getUTCDate() - 89)
  else if (win === 'quarter') d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1)
  else d.setUTCMonth(0, 1)
  return d.toISOString().slice(0, 10)
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')
const isOpen = (o: Opportunity) => o.stage !== 'Won' && o.stage !== 'Lost'

interface Metric { k: string; v: string; sub: string }

export default function Reports() {
  const { lists, user, users } = useSession()
  const manager = user.role !== 'salesperson'
  const [win, setWin] = useState<Win>('90')
  const [group, setGroup] = useState<Group>('sales')
  const today = todayIso()
  const start = windowStart(win, today)

  const data = useLoad(() => Promise.all([
    api<Opportunity[]>('/opportunities', { params: { include_nurtured: true } }),
    api<Prospect[]>('/prospects', { params: { scope: 'all' } }),
    api<PipelineReport>('/reports/pipeline'),
    api<ActionsResponse>('/actions', { params: { scope: manager ? 'team' : 'me' } }),
  ]), [manager])
  const [opps, prospects, pipeline, actions] = data.data || [[], [], null, null]

  const metrics = useMemo<Metric[]>(() => {
    if (!pipeline || !actions) return []
    const inWin = (d: string | null | undefined) => !!d && d.slice(0, 10) >= start && d.slice(0, 10) <= today
    const newProspects = prospects.filter((p) => inWin(p.created_at))
    const engagedPlus = newProspects.filter((p) => ['Engaged', 'Qualified'].includes(p.status))
    const qualified = newProspects.filter((p) => p.status === 'Qualified')
    const withOpp = new Set(opps.map((o) => o.primary_contact_id).filter(Boolean))
    const qualifiedConverted = qualified.filter((p) => withOpp.has(p.id))
    const won = opps.filter((o) => o.stage === 'Won' && inWin(o.won_date))
    const lost = opps.filter((o) => o.stage === 'Lost' && inWin(o.lost_date))
    const wonValue = totalsByCurrency(won, (o) => o.actual_value)
    const avg = Object.fromEntries(Object.entries(wonValue).map(([c, v]) => [c, v / won.filter((o) => o.currency === c).length]))
    const openActions = actions.counts.overdue + actions.counts.today + actions.counts.upcoming
    return [
      { k: 'Prospect → engaged', v: pct(engagedPlus.length, newProspects.length), sub: `${engagedPlus.length} of ${newProspects.length} new prospects are now Engaged or Qualified` },
      { k: 'Prospect → qualified', v: pct(qualified.length, newProspects.length), sub: `${qualified.length} of ${newProspects.length} new prospects are now Qualified` },
      { k: 'Qualified → opportunity', v: pct(qualifiedConverted.length, qualified.length), sub: `${qualifiedConverted.length} of ${qualified.length} qualified prospects have an opportunity` },
      { k: 'Win rate', v: pct(won.length, won.length + lost.length), sub: `${won.length} won ÷ ${won.length + lost.length} closed (won + lost)` },
      { k: 'Average deal value', v: moneyByCurrency(avg), sub: `Actual contract value, ${won.length} won deal${won.length === 1 ? '' : 's'}` },
      { k: 'Weighted forecast', v: moneyByCurrency(pipeline.active_forecast.weighted), sub: `${pipeline.active_forecast.count} open, non-nurtured opportunities · today` },
      { k: 'Overdue next actions', v: String(actions.counts.overdue), sub: `${actions.counts.overdue} of ${openActions} open actions past due · ${manager ? 'team' : 'yours'}, today` },
      { k: 'Nurtured value', v: moneyByCurrency(pipeline.nurture.value), sub: `${pipeline.nurture.count} opportunit${pipeline.nurture.count === 1 ? 'y' : 'ies'} on nurture · today` },
    ]
  }, [opps, prospects, pipeline, actions, start, today, manager])

  const funnel = lists.prospect_statuses.map((s) => ({ label: s, count: prospects.filter((p) => p.status === s).length }))
  const fmax = Math.max(1, ...funnel.map((f) => f.count))
  const openStages = (pipeline?.stages || []).filter((s) => !['Won', 'Lost'].includes(s.stage) && s.count > 0)

  const table = useMemo(() => {
    const keyOf: Record<Group, (o: Opportunity) => string> = {
      sales: (o) => o.owner_name || 'Unassigned', geo: (o) => o.geography || 'Unknown', service: (o) => o.service_line || 'Not set',
    }
    const groups = new Map<string, Opportunity[]>()
    for (const o of opps) groups.set(keyOf[group](o), [...(groups.get(keyOf[group](o)) || []), o])
    if (group === 'sales') for (const u of users) if (u.active !== false && !groups.has(u.name)) groups.set(u.name, [])
    const overdueBy = new Map<string, number>()
    for (const a of actions?.overdue || []) overdueBy.set(a.owner_name || 'Unassigned', (overdueBy.get(a.owner_name || 'Unassigned') || 0) + 1)
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, rs]) => {
      const open = rs.filter((o) => isOpen(o) && !o.on_nurture)
      const won = rs.filter((o) => o.stage === 'Won')
      const lost = rs.filter((o) => o.stage === 'Lost')
      return {
        name,
        owned: group === 'sales' ? String(prospects.filter((p) => (p.owner_name || 'Unassigned') === name).length) : null,
        open: `${open.length} · ${moneyByCurrency(totalsByCurrency(open, (o) => o.estimated_value))}`,
        weighted: moneyByCurrency(totalsByCurrency(open, (o) => o.weighted_value)),
        nurture: String(rs.filter((o) => o.on_nurture).length),
        overdue: group === 'sales' ? String(overdueBy.get(name) || 0) : null,
        won: `${won.length}${won.length ? ` · ${moneyByCurrency(totalsByCurrency(won, (o) => o.actual_value))}` : ''}`,
        lost: String(lost.length),
      }
    })
  }, [opps, prospects, actions, users, group])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports &amp; metrics</h1>
          <p>Every rate shows its numerator, denominator and date window. Currencies are listed side by side, never added together.</p>
        </div>
        <Segmented<Win> label="Date window" value={win} onChange={setWin}
          options={[{ value: '90', label: 'Last 90 days' }, { value: 'quarter', label: 'This quarter' }, { value: 'ytd', label: 'Year to date' }]} />
      </div>
      <ErrorBanner error={data.error} />
      {data.loading && !data.data ? <div className="loading">Loading reports…</div> : <>
        <p className="muted small" style={{ margin: 0 }}>Window: {fmtDate(start)} – {fmtDate(today)}. Conversion and win rates use records created or closed in this window; forecast, overdue and nurture figures are as of today.</p>
        <section className="tiles" aria-label="Key metrics">
          {metrics.map((m) => (
            <div className="tile" key={m.k}><span className="k">{m.k}</span><span className="v" style={m.v.includes('·') ? { fontSize: 18 } : undefined}>{m.v}</span><span className="s">{m.sub}</span></div>
          ))}
        </section>

        <div className="cols">
          <section className="card col-side" aria-label="Prospect funnel">
            <div className="card-head"><h2>Prospect funnel</h2><Link to="/prospects" className="small">Open prospects</Link></div>
            {funnel.map((f) => (
              <div className="bar-row" key={f.label}>
                <span>{f.label}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(f.count / fmax) * 100}%`, background: FUNNEL_COLOR[f.label] || '#8A959C' }} /></div>
                <span className="mono">{f.count}</span>
              </div>
            ))}
            <span className="muted small">Current status of all {prospects.length} prospects.</span>
          </section>
          <section className="card col-main" aria-label="Open pipeline by stage">
            <div className="card-head"><h2>Open pipeline by stage</h2><Link to="/pipeline" className="small">Open board</Link></div>
            {openStages.length === 0 && <p className="muted" style={{ margin: 0 }}>No open, non-nurtured opportunities.</p>}
            {openStages.map((s, i) => (
              <div className="bar-row" key={s.stage}>
                <span>{s.stage} <span className="muted small">· {s.probability}%</span></span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(s.count / Math.max(...openStages.map((x) => x.count))) * 100}%`, background: STAGE_COLOR[i % STAGE_COLOR.length] }} /></div>
                <span className="small">{s.count} · {moneyByCurrency(s.unweighted)}</span>
              </div>
            ))}
            <span className="muted small">Bar length = number of deals. Values are unweighted, per currency; nurtured deals are excluded.</span>
          </section>
        </div>

        <section className="card" aria-label="Breakdown">
          <Tabs<Group> label="Breakdown" value={group} onChange={setGroup}
            tabs={[{ value: 'sales', label: 'By salesperson' }, { value: 'geo', label: 'By geography' }, { value: 'service', label: 'By service line' }]} />
          <div className="table-wrap">
            <table style={{ minWidth: 820 }}>
              <thead><tr>
                <th>{group === 'sales' ? 'Salesperson' : group === 'geo' ? 'Country' : 'Service line'}</th>
                {group === 'sales' && <th>Owned prospects</th>}
                <th>Open pipeline</th><th>Weighted forecast</th><th>On nurture</th>
                {group === 'sales' && <th>Overdue actions</th>}
                <th>Wins (all time)</th><th>Losses (all time)</th>
              </tr></thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.name}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    {r.owned !== null && <td>{r.owned}</td>}
                    <td>{r.open}</td><td>{r.weighted}</td><td>{r.nurture}</td>
                    {r.overdue !== null && <td>{r.overdue}</td>}
                    <td>{r.won}</td><td>{r.lost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {table.length === 0 && <div className="empty">No opportunities yet.</div>}
          </div>
          {group === 'sales' && !manager && <span className="muted small">Overdue counts show your own actions only; managers see the whole team.</span>}
        </section>
      </>}
    </>
  )
}
