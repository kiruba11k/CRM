// Quarterly targets vs won and weighted pipeline, per salesperson and
// currency. Managers and admins set targets inline.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate } from '../format'
import { useSession } from '../session'
import { Avatar } from '../theme'
import type { QuotaLine, QuotaResponse, QuotaRow } from '../types'
import { ErrorBanner, useLoad } from '../ui'
import { AttainmentBar, lineMoney } from './Insights'
import { useToast } from './Toast'

function TargetInput({ row, currency, period, onSaved }: { row: QuotaRow; currency: string; period: string; onSaved: (q: QuotaResponse) => void }) {
  const current = row.target[currency]
  const [v, setV] = useState(current != null ? String(Math.round(Number(current))) : '')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const save = async () => {
    const amount = v.trim() === '' ? null : Number(v.replace(/[^0-9.]/g, ''))
    if ((amount ?? null) === (current != null ? Math.round(Number(current)) : null)) return
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) { toast('Enter a number, or leave it empty for no target.', { kind: 'err' }); return }
    setBusy(true)
    try {
      onSaved(await api<QuotaResponse>('/quotas', { method: 'PUT', body: { period, user_id: row.user_id, currency, amount: amount || null } }))
      toast(amount ? `Target saved for ${row.name}.` : `Target removed for ${row.name}.`)
    } catch (e) {
      toast((e as ApiError).message || 'Couldn’t save the target.', { kind: 'err' })
    } finally { setBusy(false) }
  }
  return (
    <input className="input quota-input mono" inputMode="numeric" aria-label={`${row.name} ${currency} target`} placeholder="No target" disabled={busy}
      value={v} onChange={(e) => setV(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

export default function Targets() {
  const { lists } = useSession()
  const [period, setPeriod] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [currency, setCurrency] = useState(lists.currencies[0] || 'USD')
  const q = useLoad(() => api<QuotaResponse>('/quotas', { params: period ? { period } : {} }), [period])
  const [override, setOverride] = useState<QuotaResponse | null>(null)
  const data = override && override.period === q.data?.period ? override : q.data
  const pace = data && data.current ? Math.round((data.days_elapsed / data.days_total) * 100) : undefined

  const lineFor = (r: { by_currency: QuotaLine[] }) =>
    r.by_currency.find((l) => l.currency === currency) || { currency, target: null, won: 0, pipeline: 0, weighted: 0, attainment: null, projected: null, gap: null }
  const curs = data ? Array.from(new Set([...lists.currencies, ...data.team.by_currency.map((l) => l.currency)])) : lists.currencies
  const team = data ? lineFor(data.team) : null

  return (
    <section className="card" aria-label="Targets">
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2>Targets · {data?.period || '…'}</h2>
          {data && <span className="muted small">{fmtDate(data.start)} – {fmtDate(data.end)}{data.current ? ` · day ${data.days_elapsed} of ${data.days_total}` : ''}</span>}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="Currency">
            {curs.map((c) => <button key={c} type="button" aria-pressed={c === currency} onClick={() => setCurrency(c)}>{c}</button>)}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn" aria-label="Previous quarter" disabled={!data} onClick={() => { setOverride(null); setPeriod(data!.previous) }}>‹</button>
            <button type="button" className="btn" disabled={!data || data.current} onClick={() => { setOverride(null); setPeriod(data!.this_quarter) }}>This quarter</button>
            <button type="button" className="btn" aria-label="Next quarter" disabled={!data} onClick={() => { setOverride(null); setPeriod(data!.next) }}>›</button>
          </div>
          {data?.can_edit && <button type="button" className={`btn ${editing ? 'btn-dark' : 'btn-outline'}`} onClick={() => setEditing((e) => !e)}>{editing ? 'Done' : 'Set targets'}</button>}
        </div>
      </div>
      <ErrorBanner error={q.error} />
      {data && team && (
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <thead><tr>
              <th>Salesperson</th><th className="num">Target</th><th className="num">Won</th><th className="num">Weighted pipeline</th>
              <th>Attainment</th><th className="num">Gap to target</th>
            </tr></thead>
            <tbody>
              {data.rows.map((r) => {
                const l = lineFor(r)
                return (
                  <tr key={r.user_id}>
                    <td><span className="row" style={{ gap: 8 }}><Avatar name={r.name} size={26} /><span style={{ fontWeight: 600 }}>{r.name}</span></span></td>
                    <td className="num">{editing ? <TargetInput key={`${r.user_id}-${currency}-${data.period}`} row={r} currency={currency} period={data.period} onSaved={setOverride} /> : l.target ? lineMoney(l, 'target') : <span className="muted">—</span>}</td>
                    <td className="num">{lineMoney(l, 'won')}<br /><span className="muted small">{r.won_count} deal{r.won_count === 1 ? '' : 's'} (all currencies)</span></td>
                    <td className="num">{lineMoney(l, 'weighted')}<br /><span className="muted small">of {lineMoney(l, 'pipeline')} open</span></td>
                    <td><AttainmentBar line={l} expected={pace} /></td>
                    <td className="num">{l.gap == null ? <span className="muted">—</span> : Number(l.gap) === 0 ? <span className="pill pill-teal">Hit</span> : lineMoney(l, 'gap')}</td>
                  </tr>
                )
              })}
              <tr style={{ fontWeight: 700 }}>
                <td>Team</td><td className="num">{team.target ? lineMoney(team, 'target') : '—'}</td><td className="num">{lineMoney(team, 'won')}</td>
                <td className="num">{lineMoney(team, 'weighted')}</td><td><AttainmentBar line={team} expected={pace} /></td>
                <td className="num">{team.gap == null ? '—' : Number(team.gap) === 0 ? 'Hit' : lineMoney(team, 'gap')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <span className="muted small">
        Won = contract value of deals won this quarter. Weighted pipeline = open, non-nurtured deals expected to close this quarter × stage probability
        {data?.current ? ' (including ones whose close date has passed)' : ''}. Projected = won + weighted. {pace !== undefined && 'The thin marker shows where you’d be at an even pace. '}
        Currencies are never added together.
      </span>
    </section>
  )
}
