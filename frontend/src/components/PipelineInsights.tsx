// Reports → Pipeline insights: weekly pipeline trend, how long deals sit in
// each stage, and win/loss by salesperson, service line and source.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { fmtDate, money, moneyByCurrency } from '../format'
import { useSession } from '../session'
import { stageColor } from '../theme'
import { ErrorBanner, Segmented, useLoad } from '../ui'

type Num = number | string
interface Point { date: string; source: 'snapshot' | 'history'; deals: number; by_currency: Record<string, { deals: number; unweighted: Num; weighted: Num }> }
interface Speed { stage: string; moves: number; avg_days: number | null; median_days: number | null }
interface WLRow { name: string; won: number; lost: number; win_rate: number | null; avg_cycle_days: number | null; won_value: Record<string, Num> }
interface WinLoss { since: string; overall: Omit<WLRow, 'name'>; by_owner: WLRow[]; by_service: WLRow[]; by_source: WLRow[]; loss_reasons: { reason: string; count: number }[] }
interface Insights { trend: Point[]; stage_speed: Speed[]; win_loss: WinLoss; months: number }

const SYM: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }
function compact(v: number, cur: string): string {
  const s = SYM[cur] || `${cur} `
  if (Math.abs(v) >= 1e6) return `${s}${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (Math.abs(v) >= 1e3) return `${s}${Math.round(v / 1e3)}k`
  return `${s}${Math.round(v)}`
}
function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) || 10 * p
}

// ── Trend line chart (one currency: unweighted vs weighted, same axis) ──
function TrendChart({ points, cur }: { points: Point[]; cur: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = 240, padL = 56, padR = 92, padT = 14, padB = 30
  const series = useMemo(() => points.map((p) => ({
    u: Number(p.by_currency[cur]?.unweighted || 0), wt: Number(p.by_currency[cur]?.weighted || 0), n: p.by_currency[cur]?.deals || 0,
  })), [points, cur])
  const max = niceMax(Math.max(...series.map((s) => s.u), 1))
  const x = (i: number) => padL + (points.length === 1 ? 0 : (i * (w - padL - padR)) / (points.length - 1))
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max)
  const line = (k: 'u' | 'wt') => series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`).join(' ')
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  const last = series[series.length - 1]
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * w
    let best = 0
    points.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i })
    setHover(best)
  }
  const h = hover !== null ? series[hover] : null
  return (
    <div ref={wrap} className="trend-wrap">
      <svg width={w} height={H} role="img" aria-label={`Open pipeline in ${cur} by week`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="chart-axis">{compact(t, cur)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1) && (
          <text key={p.date} x={x(i)} y={H - 8} textAnchor="middle" className="chart-axis">{i === points.length - 1 ? 'Today' : fmtDate(p.date).replace(/ \d{4}$/, '')}</text>
        ))}
        <path d={line('u')} className="chart-line s2" />
        <path d={line('wt')} className="chart-line s1" />
        {series.map((s, i) => (
          <g key={i}>
            {(['u', 'wt'] as const).map((k) => (
              <circle key={k} cx={x(i)} cy={y(s[k])} r={4} className={`chart-dot ${k === 'u' ? 's2' : 's1'}${points[i].source === 'history' ? ' rebuilt' : ''}`} />
            ))}
          </g>
        ))}
        {last && <>
          <text x={w - padR + 10} y={y(last.u) + 4} className="chart-label">Unweighted</text>
          <text x={w - padR + 10} y={y(last.wt) + 4 + (Math.abs(y(last.u) - y(last.wt)) < 14 ? 14 : 0)} className="chart-label">Weighted</text>
        </>}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} className="chart-cross" />}
      </svg>
      {hover !== null && h && (
        <div className="chart-tip" style={{ left: Math.min(x(hover) + 12, w - 210), top: 8 }}>
          <strong>{hover === points.length - 1 ? 'Today' : `Week ending ${fmtDate(points[hover].date)}`}</strong>
          <span><i className="sw s2" />Unweighted {money(h.u, cur)}</span>
          <span><i className="sw s1" />Weighted {money(h.wt, cur)}</span>
          <span className="muted">{h.n} open deal{h.n === 1 ? '' : 's'}{points[hover].source === 'history' ? ' · rebuilt from history' : ''}</span>
        </div>
      )}
    </div>
  )
}

type Group = 'owner' | 'service' | 'source'

export default function PipelineInsights() {
  const { lists } = useSession()
  const [months, setMonths] = useState(12)
  const data = useLoad(() => api<Insights>('/reports/insights', { params: { weeks: 12, months } }), [months])
  const curs = useMemo(() => {
    const seen = new Set<string>()
    for (const p of data.data?.trend || []) for (const c of Object.keys(p.by_currency)) seen.add(c)
    return lists.currencies.filter((c) => seen.has(c)).concat([...seen].filter((c) => !lists.currencies.includes(c)))
  }, [data.data, lists.currencies])
  const [cur, setCur] = useState<string | null>(null)
  const currency = cur && curs.includes(cur) ? cur : curs[0] || lists.currencies[0] || 'USD'
  const [group, setGroup] = useState<Group>('owner')
  const d = data.data
  const trend = d?.trend || []
  const first = trend[0], last = trend[trend.length - 1]
  const delta = first && last ? Number(last.by_currency[currency]?.weighted || 0) - Number(first.by_currency[currency]?.weighted || 0) : 0
  const speedMax = Math.max(1, ...(d?.stage_speed || []).map((s) => s.avg_days || 0))
  const wl = d?.win_loss
  const rows = wl ? (group === 'owner' ? wl.by_owner : group === 'service' ? wl.by_service : wl.by_source) : []
  const reasonMax = Math.max(1, ...(wl?.loss_reasons || []).map((r) => r.count))

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Pipeline insights</h2>
        <Segmented<string> label="Win/loss and stage window" value={String(months)} onChange={(v) => setMonths(Number(v))}
          options={[{ value: '3', label: '3 months' }, { value: '6', label: '6 months' }, { value: '12', label: '12 months' }]} />
      </div>
      <ErrorBanner error={data.error} />
      {!d && data.loading && <div className="loading" data-label="Loading insights…">Loading insights…</div>}
      {d && <>
        <section className="card" aria-label="Pipeline trend">
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h2>Open pipeline, last 12 weeks</h2>
              <span className="muted small">
                Weighted {delta >= 0 ? 'up' : 'down'} {money(Math.abs(delta), currency)} since {fmtDate(first?.date)} · open, non-nurtured deals in {currency}
              </span>
            </div>
            {curs.length > 1 && (
              <div className="seg" role="group" aria-label="Currency">
                {curs.map((c) => <button key={c} type="button" aria-pressed={c === currency} onClick={() => setCur(c)}>{c}</button>)}
              </div>
            )}
          </div>
          <div className="chart-legend">
            <span><i className="sw s2" />Unweighted value</span><span><i className="sw s1" />Weighted (× stage probability)</span>
            {trend.some((p) => p.source === 'history') && <span><i className="sw hollow" />Rebuilt from change history (before daily snapshots began)</span>}
          </div>
          <TrendChart points={trend} cur={currency} />
          <details className="small">
            <summary>Show as table</summary>
            <div className="table-wrap"><table style={{ minWidth: 480 }}>
              <thead><tr><th>Week ending</th><th className="num">Open deals</th><th className="num">Unweighted</th><th className="num">Weighted</th><th>Source</th></tr></thead>
              <tbody>{trend.map((p) => (
                <tr key={p.date}><td>{fmtDate(p.date)}</td><td className="num">{p.by_currency[currency]?.deals || 0}</td>
                  <td className="num">{money(p.by_currency[currency]?.unweighted || 0, currency)}</td><td className="num">{money(p.by_currency[currency]?.weighted || 0, currency)}</td>
                  <td className="muted">{p.source === 'snapshot' ? 'Daily snapshot' : 'Rebuilt'}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
        </section>

        <div className="cols">
          <section className="card col-side" aria-label="Stage speed">
            <div className="card-head"><h2>Time in each stage</h2><span className="muted small">last {months} months</span></div>
            {d.stage_speed.map((s) => (
              <div className="bar-row" key={s.stage} title={s.moves ? `${s.moves} deal${s.moves === 1 ? '' : 's'} moved on · median ${s.median_days} days` : 'No deals left this stage yet'}>
                <span>{s.stage}</span>
                <div className="bar-track">{s.avg_days != null && <div className="bar-fill" style={{ width: `${(s.avg_days / speedMax) * 100}%`, background: stageColor(s.stage) }} />}</div>
                <span className="small">{s.avg_days != null ? `${Math.round(s.avg_days)} d` : '—'}</span>
              </div>
            ))}
            <span className="muted small">Average days before a deal moved to its next stage (won, lost or onward). Hover a row for the median and count.</span>
          </section>

          <section className="card col-main" aria-label="Win and loss">
            <div className="card-head"><h2>Wins &amp; losses</h2><span className="muted small">closed since {fmtDate(wl!.since)}</span></div>
            <section className="tiles">
              <div className="tile"><span className="k">Win rate</span><span className="v">{wl!.overall.win_rate ?? '—'}{wl!.overall.win_rate != null ? '%' : ''}</span><span className="s">{wl!.overall.won} won ÷ {wl!.overall.won + wl!.overall.lost} closed</span></div>
              <div className="tile"><span className="k">Average sales cycle</span><span className="v">{wl!.overall.avg_cycle_days ?? '—'}{wl!.overall.avg_cycle_days != null ? ' d' : ''}</span><span className="s">Created to won</span></div>
              <div className="tile"><span className="k">Won value</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(Object.fromEntries(Object.entries(wl!.overall.won_value).map(([k, v]) => [k, Number(v)])))}</span><span className="s">Actual contract value</span></div>
            </section>
            <Segmented<Group> label="Break down by" value={group} onChange={setGroup}
              options={[{ value: 'owner', label: 'Salesperson' }, { value: 'service', label: 'Service line' }, { value: 'source', label: 'Deal source' }]} />
            <div className="table-wrap"><table style={{ minWidth: 520 }}>
              <thead><tr><th>{group === 'owner' ? 'Salesperson' : group === 'service' ? 'Service line' : 'Source'}</th><th className="num">Won</th><th className="num">Lost</th><th>Win rate</th><th className="num">Avg cycle</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.name}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td><td className="num">{r.won}</td><td className="num">{r.lost}</td>
                  <td><div className="wr"><div className="bar-track"><div className="bar-fill" style={{ width: `${r.win_rate || 0}%`, background: 'var(--series-1)' }} /></div><span className="small">{r.win_rate ?? '—'}%</span></div></td>
                  <td className="num">{r.avg_cycle_days != null ? `${r.avg_cycle_days} d` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>{rows.length === 0 && <div className="empty">No deals closed in this window.</div>}</div>
            {wl!.loss_reasons.length > 0 && <>
              <h3 className="small" style={{ margin: '6px 0 0', textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--ink-soft)' }}>Why deals were lost</h3>
              {wl!.loss_reasons.map((r) => (
                <div className="bar-row" key={r.reason}><span>{r.reason}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.count / reasonMax) * 100}%`, background: 'var(--series-2)' }} /></div>
                  <span className="small">{r.count}</span></div>
              ))}
            </>}
          </section>
        </div>
      </>}
    </>
  )
}
