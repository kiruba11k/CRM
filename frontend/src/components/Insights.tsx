// Going-quiet deals and quarter attainment, shared by My Actions, Pipeline
// and Reports.
import { Link } from 'react-router-dom'
import { fmtDate, money } from '../format'
import type { QuotaLine, StaleDeal } from '../types'
import { Avatar, StagePill } from '../theme'

import HealthPill from './HealthPill'

const REASON_PILL: Record<StaleDeal['reasons'][number]['code'], string> = {
  no_action: 'red', action_overdue: 'amber', quiet: 'amber', overdue: 'red', slipping: 'purple', stalled: 'blue', high_risk: 'red', large: 'teal',
}

export function QuietDeals({ items, team, staleDays }: { items: StaleDeal[]; team: boolean; staleDays: number }) {
  return (
    <section className="section" aria-label="At-risk deals">
      <div className="section-head" style={{ background: 'var(--amber-soft)' }}>
        <h2 style={{ color: 'var(--amber-ink)' }}>At-risk deals <span style={{ fontWeight: 500 }}>· {items.length}</span></h2>
        <span className="muted small">Scored on next action, {staleDays}+ quiet days, close date, slips, time in stage and risk</span>
      </div>
      {items.length === 0 && <div className="action-row muted">No open deal is at risk.</div>}
      {items.slice(0, 12).map((d) => (
        <div className="action-row quiet-row" key={d.id}>
          <span className="kind"><HealthPill deal={d} /></span>
          <div className="who">
            <Link to={`/opportunities/${d.id}`} style={{ fontWeight: 600 }}>{d.name}</Link>
            <span className="muted small">{d.account_name} · {money(d.estimated_value, d.currency)}{d.expected_close ? ` · close ${fmtDate(d.expected_close)}` : ''}</span>
          </div>
          <div className="what">
            <span className="small"><StagePill stage={d.stage} /> Last activity {fmtDate(d.last_touch)}{d.days_in_stage != null ? ` · ${d.days_in_stage} days in stage` : ''}</span>
            {team && <span className="small row" style={{ gap: 6 }}><Avatar name={d.owner_name} size={20} />{d.owner_name || 'Unassigned'}</span>}
          </div>
          <div className="flags">
            {d.reasons.map((r) => <span key={r.code} className={`pill pill-${REASON_PILL[r.code]}`}>{r.label}</span>)}
          </div>
          <div className="acts"><Link className="btn btn-outline" to={`/opportunities/${d.id}`}>Open deal</Link></div>
        </div>
      ))}
      {items.length > 12 && <div className="action-row muted small">and {items.length - 12} more: <Link to="/deals?health=risk">see them all on Deals</Link></div>}
    </section>
  )
}

// One attainment bar: won (solid) + weighted pipeline (light) against the target.
export function AttainmentBar({ line, expected }: { line: QuotaLine; expected?: number }) {
  const t = Number(line.target || 0)
  if (!t) return <span className="muted small">No target</span>
  const won = Math.min(100, (Number(line.won) / t) * 100)
  const proj = Math.min(100 - won, (Number(line.weighted) / t) * 100)
  const tone = (line.attainment ?? 0) >= 100 ? 'var(--teal-ink, #0E7C6B)' : expected !== undefined && (line.projected ?? 0) < expected ? 'var(--red-ink)' : 'var(--accent, #4F46E5)'
  return (
    <div className="quota-bar" title={`${line.attainment}% won · ${line.projected}% with weighted pipeline`}>
      <div className="bar-track" style={{ position: 'relative' }}>
        <div className="bar-fill" style={{ width: `${won}%`, background: tone, float: 'left', borderRadius: proj ? '999px 0 0 999px' : undefined }} />
        <div className="bar-fill" style={{ width: `${proj}%`, background: tone, opacity: 0.3, float: 'left', borderRadius: won ? '0 999px 999px 0' : undefined }} />
        {expected !== undefined && <span className="quota-pace" style={{ left: `${Math.min(100, expected)}%` }} aria-hidden="true" />}
      </div>
      <span className="small"><strong>{line.attainment ?? 0}%</strong> won · {line.projected ?? 0}% projected</span>
    </div>
  )
}

export function lineMoney(line: QuotaLine, key: 'target' | 'won' | 'weighted' | 'pipeline' | 'gap') {
  return money(line[key] as number | string | null | undefined, line.currency)
}
