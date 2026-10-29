// §7 Pipeline Kanban: opportunities by stage with account, value, owner,
// close date, risk and next action. Nurtured ones are hidden by default.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { fmtDate, money, moneyByCurrency, todayIso } from '../format.js'
import { useSession } from '../session.jsx'
import { ErrorBanner, RiskPill, SelectField, useLoad } from '../ui.jsx'

const STAGE_COLOR = {
  'Lead identified': '#8A959C', Qualified: '#2E5EAA', 'Discovery / scoping': '#3E7CB1', 'Solution design': '#D99000',
  'Proposal submitted': '#E85D3D', Negotiation: '#7A4FB5', 'Verbal commitment': '#5B3B8C', Won: '#0E7C6B', Lost: '#C93A2B',
}

function sums(opps, prob) {
  const u = {}, w = {}
  for (const o of opps) {
    const v = Number(o.estimated_value || 0)
    u[o.currency] = (u[o.currency] || 0) + v
    w[o.currency] = (w[o.currency] || 0) + v * prob / 100
  }
  return { u, w }
}

export default function Pipeline() {
  const { lists, users } = useSession()
  const [showNurture, setShowNurture] = useState(false)
  const [f, setF] = useState({ owner: null, risk: null, service: null })
  const { data, error, loading } = useLoad(() => api('/opportunities', { params: { include_nurtured: true } }), [])
  const report = useLoad(() => api('/reports/pipeline'), [])
  const today = todayIso()

  const visible = useMemo(() => (data || []).filter((o) =>
    (showNurture || !o.on_nurture) && (!f.owner || o.owner_id === f.owner) && (!f.risk || o.risk_rating === f.risk) && (!f.service || o.service_line === f.service)), [data, f, showNurture])
  const nurtureCount = (data || []).filter((o) => o.on_nurture).length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p>Open opportunities by sales stage. Open a card to change its stage. Nurtured opportunities keep their stage but are left out of the active board and forecast.</p>
        </div>
      </div>
      {report.data && (
        <section className="tiles" aria-label="Active forecast">
          <div className="tile"><span className="k">Active forecast · unweighted</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(report.data.active_forecast.unweighted)}</span><span className="s">{report.data.active_forecast.count} open, non-nurtured</span></div>
          <div className="tile"><span className="k">Weighted (value × probability)</span><span className="v" style={{ fontSize: 18, color: 'var(--teal-ink)' }}>{moneyByCurrency(report.data.active_forecast.weighted)}</span><span className="s">Currencies are never added together</span></div>
          <div className="tile"><span className="k">On nurture</span><span className="v" style={{ fontSize: 18, color: 'var(--purple-ink)' }}>{moneyByCurrency(report.data.nurture.value)}</span><span className="s">{report.data.nurture.count} opportunities · <Link to="/views">Nurture pipeline</Link></span></div>
        </section>
      )}
      <div className="row-end">
        <div style={{ width: 180 }}><SelectField label="Owner" value={f.owner} onChange={(owner) => setF({ ...f, owner })} placeholder="All owners" options={users.map((u) => ({ value: u.id, label: u.name }))} /></div>
        <div style={{ width: 180 }}><SelectField label="Risk rating" value={f.risk} onChange={(risk) => setF({ ...f, risk })} placeholder="All ratings" options={lists.risk_ratings} /></div>
        <div style={{ width: 220 }}><SelectField label="Service line" value={f.service} onChange={(service) => setF({ ...f, service })} placeholder="All service lines" options={lists.service_lines} /></div>
        <label className="check"><input type="checkbox" checked={showNurture} onChange={() => setShowNurture(!showNurture)} />Show nurtured ({nurtureCount})</label>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <div className="loading">Loading pipeline…</div> : (
        <div className="board-scroll">
          <div className="board">
            {lists.stages.map(({ name, probability }) => {
              const cards = visible.filter((o) => o.stage === name)
              const closed = name === 'Won' || name === 'Lost'
              const { u, w } = sums(cards.filter((o) => !o.on_nurture), probability)
              return (
                <section key={name} className={`column${closed ? ' closed' : ''}`} aria-label={name}>
                  <div className="column-bar" style={{ background: STAGE_COLOR[name] }} />
                  <div className="column-head"><span>{name} <span className="muted">{cards.length}</span></span><span className="mono muted">{probability}%</span></div>
                  <div className="column-cards">
                    {cards.map((o) => {
                      const overdue = !closed && !o.on_nurture && o.next_action_due && o.next_action_due < today
                      return (
                        <Link key={o.id} to={`/opportunities/${o.id}`} className={`deal-card${o.on_nurture ? ' nurture' : o.risk_rating === 'High' ? ' risk-high' : ''}`}>
                          <span className="small muted" style={{ fontWeight: 600 }}>{o.account_name}</span>
                          <span className="title">{o.name}</span>
                          <span className="mono" style={{ fontWeight: 600 }}>{money(o.estimated_value, o.currency)}</span>
                          <div className="row" style={{ gap: 6 }}><RiskPill risk={o.risk_rating} />{o.on_nurture && <span className="pill pill-purple">On nurture</span>}</div>
                          <span className="small muted">Close {fmtDate(o.expected_close)} · {o.owner_name}</span>
                          <span className="small" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 6, fontWeight: 600, color: overdue ? 'var(--red-ink)' : undefined }}>
                            {closed ? (name === 'Won' ? `Won ${fmtDate(o.won_date)} · ${money(o.actual_value, o.currency)}` : `Lost ${fmtDate(o.lost_date)} · ${o.lost_reason}`)
                              : o.on_nurture ? `Revisit ${fmtDate(o.nurture_until)}` : `${o.next_action_label} · ${overdue ? 'overdue since ' : ''}${fmtDate(o.next_action_due)}`}
                          </span>
                        </Link>
                      )
                    })}
                    {cards.length === 0 && <div className="empty small" style={{ border: '1px dashed var(--line-input)', borderRadius: 10, padding: 12 }}>None</div>}
                  </div>
                  <div className="column-foot">{moneyByCurrency(u)}<br />weighted {moneyByCurrency(w)}</div>
                </section>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
