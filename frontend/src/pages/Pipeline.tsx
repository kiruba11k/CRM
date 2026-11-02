// §7 Pipeline Kanban: opportunities by stage with account, value, owner,
// close date, risk and next action. Nurtured ones are hidden by default.
// Drag a card to another column to change its stage: it moves at once,
// asks for any details the new stage requires, and slides back if the
// save fails. Each move can be undone from the toast.
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import StageMoveDialog from '../components/StageMove'
import { useToast } from '../components/Toast'
import { fmtDate, money, moneyByCurrency, todayIso, totalsByCurrency } from '../format'
import { useSession } from '../session'
import type { FieldErrors, Opportunity, PipelineReport } from '../types'
import { ErrorBanner, RiskPill, SelectField, useLoad } from '../ui'

const STAGE_COLOR: Record<string, string> = {
  'Lead identified': '#8A959C', Qualified: '#2E5EAA', 'Discovery / scoping': '#3E7CB1', 'Solution design': '#D99000',
  'Proposal submitted': '#E85D3D', Negotiation: '#7A4FB5', 'Verbal commitment': '#5B3B8C', Won: '#0E7C6B', Lost: '#C93A2B',
}

interface Filters { owner: string | null; risk: string | null; service: string | null }

function cardFooter(o: Opportunity, closed: boolean, overdue: boolean): string {
  if (closed) return o.stage === 'Won' ? `Won ${fmtDate(o.won_date)} · ${money(o.actual_value, o.currency)}` : `Lost ${fmtDate(o.lost_date)} · ${o.lost_reason}`
  if (o.on_nurture) return `Revisit ${fmtDate(o.nurture_until)}`
  return `${o.next_action_label} · ${overdue ? 'overdue since ' : ''}${fmtDate(o.next_action_due)}`
}

export default function Pipeline() {
  const { lists, users } = useSession()
  const [showNurture, setShowNurture] = useState(false)
  const [f, setF] = useState<Filters>({ owner: null, risk: null, service: null })
  const { data, error, loading } = useLoad(() => api<Opportunity[]>('/opportunities', { params: { include_nurtured: true } }), [])
  const report = useLoad(() => api<PipelineReport>('/reports/pipeline'), [])
  const today = todayIso()
  const toast = useToast()
  const [rows, setRows] = useState<Opportunity[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [landed, setLanded] = useState<string | null>(null)
  const [pending, setPending] = useState<{ opp: Opportunity; stage: string; errors: FieldErrors } | null>(null)
  useEffect(() => { if (data) setRows(data) }, [data])

  const replace = (o: Opportunity, patch: Partial<Opportunity>) => setRows((rs) => (rs || []).map((r) => (r.id === o.id ? { ...r, ...patch } : r)))
  function settled(before: Opportunity, saved: Opportunity, undoable: boolean) {
    replace(before, { ...saved, account_name: before.account_name, owner_name: before.owner_name })
    setLanded(saved.id)
    window.setTimeout(() => setLanded((l) => (l === saved.id ? null : l)), 700)
    void report.reload()
    toast(`Moved “${before.name}” to ${saved.stage}.`, undoable ? { action: { label: 'Undo', run: () => void move({ ...before, stage: saved.stage }, before.stage, false) } } : undefined)
  }
  async function move(o: Opportunity, stage: string, undoable = true) {
    if (o.stage === stage) return
    replace(o, { stage })
    try {
      settled(o, await api<Opportunity>(`/opportunities/${o.id}`, { method: 'PATCH', body: { stage } }), undoable)
    } catch (e) {
      const err = e as ApiError
      replace(o, { stage: o.stage })
      if (err.status === 422 && Object.keys(err.fieldErrors).length) setPending({ opp: o, stage, errors: err.fieldErrors })
      else toast(err.message || 'Couldn’t move the deal.', { kind: 'err' })
    }
  }
  const dragged = (rows || []).find((o) => o.id === dragId)
  const onDragOver = (e: DragEvent, stage: string) => {
    if (!dragged || dragged.stage === stage) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (over !== stage) setOver(stage)
  }
  const onDrop = (e: DragEvent, stage: string) => {
    e.preventDefault()
    setOver(null)
    if (dragged) void move(dragged, stage)
    setDragId(null)
  }

  const visible = useMemo(() => (rows || []).filter((o) =>
    (showNurture || !o.on_nurture) && (!f.owner || o.owner_id === f.owner) && (!f.risk || o.risk_rating === f.risk) && (!f.service || o.service_line === f.service)), [rows, f, showNurture])
  const nurtureCount = (rows || []).filter((o) => o.on_nurture).length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p>Open opportunities by sales stage. Drag a card to another stage to move it, or open it to edit. Nurtured opportunities keep their stage but are left out of the active board and forecast.</p>
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
        <div style={{ width: 220 }}><SelectField label="Service line" value={f.service} onChange={(service) => setF({ ...f, service })} placeholder="All service lines" options={[...lists.service_lines, ...lists.retired.service_lines]} /></div>
        <label className="check"><input type="checkbox" checked={showNurture} onChange={() => setShowNurture(!showNurture)} />Show nurtured ({nurtureCount})</label>
      </div>
      <ErrorBanner error={error} />
      {pending && <StageMoveDialog opp={pending.opp} stage={pending.stage} errors={pending.errors} onCancel={() => setPending(null)}
        onDone={(saved) => { const p = pending; setPending(null); settled(p.opp, saved, true) }} />}
      {loading && !data ? <div className="loading" data-label="Loading pipeline…">Loading pipeline…</div> : (
        <div className="board-scroll">
          <div className="board">
            {lists.stages.map(({ name, probability }) => {
              const cards = visible.filter((o) => o.stage === name)
              const closed = name === 'Won' || name === 'Lost'
              const counted = cards.filter((o) => !o.on_nurture)
              const unweighted = totalsByCurrency(counted, (o) => o.estimated_value)
              const weighted = totalsByCurrency(counted, (o) => Number(o.estimated_value || 0) * probability / 100)
              return (
                <section key={name} className={`column${closed ? ' closed' : ''}${over === name ? ' drop-ok' : ''}`} aria-label={name}
                  onDragOver={(e) => onDragOver(e, name)} onDrop={(e) => onDrop(e, name)}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((s) => (s === name ? null : s)) }}>
                  <div className="column-bar" style={{ background: STAGE_COLOR[name] }} />
                  <div className="column-head"><span><span className="stage-dot" style={{ background: STAGE_COLOR[name] }} />{name} <span className="muted">{cards.length}</span></span><span className="mono muted">{probability}%</span></div>
                  <div className="column-cards">
                    {cards.map((o) => {
                      const overdue = !closed && !o.on_nurture && !!o.next_action_due && o.next_action_due < today
                      return (
                        <Link key={o.id} to={`/opportunities/${o.id}`} draggable aria-roledescription="draggable deal"
                          onDragStart={(e) => { e.dataTransfer.setData('text/plain', o.id); e.dataTransfer.effectAllowed = 'move'; setDragId(o.id) }}
                          onDragEnd={() => { setDragId(null); setOver(null) }}
                          className={`deal-card${o.on_nurture ? ' nurture' : o.risk_rating === 'High' ? ' risk-high' : ''}${dragId === o.id ? ' dragging' : ''}${landed === o.id ? ' landed' : ''}`}>
                          <span className="small muted" style={{ fontWeight: 600 }}>{o.account_name}</span>
                          <span className="title">{o.name}</span>
                          <div className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
                            <span style={{ fontWeight: 800 }}>{money(o.estimated_value, o.currency)}</span>
                            <span className="row" style={{ gap: 6 }}>{o.on_nurture && <span className="pill pill-purple">Nurture</span>}<RiskPill risk={o.risk_rating} /></span>
                          </div>
                          <span className="small muted">Close {fmtDate(o.expected_close)}</span>
                          <span className="deal-foot" style={{ color: overdue ? 'var(--red-ink)' : 'var(--ink-soft)' }}>
                            <span className="avatar" title={o.owner_name || 'Unassigned'} aria-label={`Owner: ${o.owner_name || 'Unassigned'}`}>{(o.owner_name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
                            {cardFooter(o, closed, overdue)}
                          </span>
                        </Link>
                      )
                    })}
                    {cards.length === 0 && over !== name && <div className="empty small" style={{ border: '1px dashed var(--line-input)', borderRadius: 10, padding: 12 }}>None</div>}
                  </div>
                  <div className="column-foot">{moneyByCurrency(unweighted)}<br />weighted {moneyByCurrency(weighted)}</div>
                </section>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
