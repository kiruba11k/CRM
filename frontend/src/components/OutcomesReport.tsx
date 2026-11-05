// What completed actions led to (CRM review §4.5), overall and per person.
import { useState } from 'react'
import { api } from '../api'
import { Avatar } from '../theme'
import { ErrorBanner, Segmented, useLoad } from '../ui'
import { OUTCOMES } from './CompleteAction'

const TONE: Record<string, string> = { teal: 'var(--teal-ink, #0E7C6B)', grey: '#9AA0B4', blue: 'var(--series-1, #4F46E5)', purple: '#8B5CF6', red: 'var(--red-ink)', amber: '#D97706' }

interface OutcomesData {
  days: number; total: number
  outcomes: { code: string; label: string; count: number }[]
  by_owner: { name: string; counts: Record<string, number>; total: number }[]
}

export default function OutcomesReport() {
  const [days, setDays] = useState<'30' | '90' | '365'>('90')
  const r = useLoad(() => api<OutcomesData>('/reports/outcomes', { params: { days } }), [days])
  const d = r.data
  const max = Math.max(1, ...(d?.outcomes || []).map((o) => o.count))
  return (
    <section className="card" aria-label="Action outcomes">
      <div className="card-head">
        <div><h2>Action outcomes</h2><span className="muted small">What happened when actions were completed{d ? ` · ${d.total} with an outcome` : ''}</span></div>
        <Segmented label="Outcome window" value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '12 months' }]} />
      </div>
      <ErrorBanner error={r.error} />
      {d && d.total === 0 && <p className="muted small" style={{ margin: 0 }}>No outcomes yet. They are recorded when someone completes an action and picks what happened.</p>}
      {d && d.total > 0 && <>
        <div style={{ display: 'grid', gap: 8, maxWidth: 760 }}>
          {d.outcomes.map((o) => (
            <div className="bar-row" key={o.code}>
              <span className="small">{o.label}</span>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(o.count / max) * 100}%`, background: TONE[OUTCOMES.find((x) => x.code === o.code)?.tone || 'grey'] }} /></div>
              <span className="small">{o.count} · {Math.round((100 * o.count) / d.total)}%</span>
            </div>
          ))}
        </div>
        <div className="table-wrap">
          <table style={{ minWidth: 720 }}>
            <thead><tr><th>Logged by</th>{OUTCOMES.map((o) => <th key={o.code} className="num">{o.label}</th>)}<th className="num">Total</th></tr></thead>
            <tbody>{d.by_owner.map((u) => (
              <tr key={u.name}>
                <td><span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><Avatar name={u.name} size={24} /><strong style={{ whiteSpace: 'nowrap' }}>{u.name}</strong></span></td>
                {OUTCOMES.map((o) => <td key={o.code} className="num">{u.counts[o.code] || 0}</td>)}
                <td className="num"><strong>{u.total}</strong></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>}
    </section>
  )
}
