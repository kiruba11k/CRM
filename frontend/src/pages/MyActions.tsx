// §5.3 / §7 My Actions: overdue, today, upcoming, nurture revisits.
// Completing an action asks for the next one; nurture revisits end in
// reactivate, extend or mark lost.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { fmtDate } from '../format'
import { useSession } from '../session'
import type { ActionItem, ActionKind, ActionsResponse, FormValues } from '../types'
import { Banner, CountUp, ErrorBanner, NextActionFields, Segmented, SelectField, TextField, useLoad } from '../ui'

type Mode = 'complete' | 'reschedule' | 'revisit'
type Outcome = 'reactivate' | 'extend' | 'lost'
type Scope = 'me' | 'team'

const KIND: Record<ActionKind, { label: string; pill: string; path: string }> = {
  prospect: { label: 'Prospect', pill: 'blue', path: '/prospects/' },
  opportunity: { label: 'Opportunity', pill: 'teal', path: '/opportunities/' },
  nurture: { label: 'Nurture revisit', pill: 'purple', path: '/opportunities/' },
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function ActionPanel({ item, mode, onDone, onCancel }: { item: ActionItem; mode: Mode; onDone: (msg: string) => void; onCancel: () => void }) {
  const { lists } = useSession()
  const [form, setForm] = useState<FormValues>(mode === 'reschedule'
    ? { next_action_code: item.code, next_action_other: item.other, next_action_due: null, next_action_time: item.due_time, next_action_in_calendar: item.in_calendar }
    : { next_action_code: null, next_action_other: null, next_action_due: null })
  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('reactivate')
  const [extra, setExtra] = useState<{ nurture_until: string | null; lost_reason: string | null; lost_date: string | null }>({ nurture_until: null, lost_reason: null, lost_date: null })
  const [error, setError] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)
  const base = item.kind === 'prospect' ? `/prospects/${item.id}` : `/opportunities/${item.id}`

  async function save() {
    setSaving(true)
    setError(null)
    try {
      let msg: string
      if (mode === 'revisit') {
        const body: FormValues = { outcome }
        if (outcome === 'reactivate') Object.assign(body, form)
        if (outcome === 'extend') body.nurture_until = extra.nurture_until
        if (outcome === 'lost') Object.assign(body, { lost_reason: extra.lost_reason, lost_date: extra.lost_date || undefined })
        await api(`${base}/revisit`, { method: 'POST', body })
        msg = outcome === 'reactivate' ? `${item.title} reactivated at its original stage.`
          : outcome === 'extend' ? `Nurture extended to ${fmtDate(extra.nurture_until)}.` : `${item.title} marked Lost. Reminders stopped.`
      } else if (mode === 'complete') {
        await api(`${base}/complete-action`, { method: 'POST', body: { ...form, note: note || undefined } })
        msg = `“${item.label}” logged as done. Next action saved.`
      } else {
        await api(base, { method: 'PATCH', body: form })
        msg = `Rescheduled to ${fmtDate(form.next_action_due as string | null)}.`
      }
      onDone(msg)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setSaving(false)
    }
  }

  const errors = error?.fieldErrors || {}
  const heading = mode === 'revisit' ? 'Nurture revisit: what happens next?' : mode === 'complete' ? 'Done. What’s the next action?' : 'Reschedule with intent'
  return (
    <section className="card strong" aria-label={heading}>
      <div>
        <h2>{heading}</h2>
        <span className="muted small">{item.title} · current action: {item.label || '—'}</span>
      </div>
      {mode === 'revisit' && (
        <Segmented<Outcome> label="Revisit outcome" value={outcome} onChange={setOutcome}
          options={[{ value: 'reactivate', label: 'Reactivate' }, { value: 'extend', label: 'Extend nurture' }, { value: 'lost', label: 'Mark lost' }]} />
      )}
      <ErrorBanner error={error} />
      <div className="grid-fields">
        {(mode !== 'revisit' || outcome === 'reactivate') && <NextActionFields value={form} onChange={setForm} errors={errors} withCalendar={item.kind !== 'nurture' || outcome === 'reactivate'} />}
        {mode === 'complete' && <TextField label="What happened? (optional)" value={note} onChange={setNote} />}
        {mode === 'revisit' && outcome === 'extend' && (
          <TextField label="New revisit date" type="date" required value={extra.nurture_until} onChange={(v) => setExtra({ ...extra, nurture_until: v || null })} error={errors.nurture_until} />
        )}
        {mode === 'revisit' && outcome === 'lost' && <>
          <SelectField label="Lost reason" required value={extra.lost_reason} onChange={(v) => setExtra({ ...extra, lost_reason: v })} options={lists.lost_reasons} placeholder="Choose…" error={errors.lost_reason} />
          <TextField label="Lost date" type="date" value={extra.lost_date} onChange={(v) => setExtra({ ...extra, lost_date: v || null })} hint="Defaults to today" />
        </>}
      </div>
      <div className="row">
        <button type="button" className="btn btn-dark" onClick={save} disabled={saving}>{saving ? 'Saving…' : mode === 'revisit' ? 'Save outcome' : 'Save next action'}</button>
        {mode === 'complete' && <Link className="btn btn-danger" to={KIND[item.kind].path + item.id}>Close the record instead</Link>}
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}

function dueText(i: ActionItem): string {
  const at = i.due_time ? ` at ${i.due_time.slice(0, 5)}` : ''
  const cal = i.in_calendar ? ' · in Calendar' : ''
  return baseDueText(i, at) + cal
}

function baseDueText(i: ActionItem, at: string): string {
  if (i.kind === 'nurture') return `Revisit ${fmtDate(i.due)}${i.days_until != null ? ` · in ${plural(i.days_until, 'day')}` : ''}`
  if (i.business_days_overdue !== undefined) return `Due ${fmtDate(i.due)}${at} · ${plural(i.business_days_overdue, 'business day')} overdue`
  if (i.days_until != null) return `Due ${fmtDate(i.due)}${at} · in ${plural(i.days_until, 'day')}`
  return `Due today${at}`
}

function Section({ title, note, tone, items, team, onOpen, leaving }: {
  title: string; note: string; tone: { bg: string; fg: string }; items: ActionItem[]; team: boolean; onOpen: (i: ActionItem, m: Mode) => void
  leaving: string | null
}) {
  return (
    <section className="section" aria-label={title}>
      <div className="section-head" style={{ background: tone.bg }}>
        <h2 style={{ color: tone.fg }}>{title} <span style={{ fontWeight: 500 }}>· {items.length}</span></h2>
        <span className="muted small">{note}</span>
      </div>
      {items.length === 0 && <div className="action-row muted">Nothing here.</div>}
      {items.map((i) => {
        const k = KIND[i.kind]
        return (
          <div className={`action-row${leaving === `${i.kind}-${i.id}` ? ' leaving' : ''}`} key={`${i.kind}-${i.id}`}>
            <span className="kind"><span className={`pill pill-${k.pill}`}>{k.label}</span></span>
            <div className="who">
              <Link to={k.path + i.id} style={{ fontWeight: 600 }}>{i.title}</Link>
              <span className="muted small">{i.account_name || 'No account yet'}{i.nurture_reason ? ` · ${i.nurture_reason}` : ''}</span>
            </div>
            <div className="what">
              <span style={{ fontWeight: 600 }}>{i.kind === 'nurture' ? 'Revisit: ' : ''}{i.label || '—'}</span>
              <span className="small" style={{ fontWeight: 600, color: tone.fg }}>{dueText(i)}{team ? ` · ${i.owner_name}` : ''}</span>
            </div>
            {/* Always present, so every row keeps the same columns. */}
            <div className="flags">
              {i.escalated && <span className="pill pill-red">Escalated to manager</span>}
              {i.due_next_business_day && <span className="pill pill-amber">Due next business day</span>}
            </div>
            <div className="acts">
              {i.kind === 'nurture'
                ? <button type="button" className="btn btn-outline" onClick={() => onOpen(i, 'revisit')}>Revisit now</button>
                : <>
                    <button type="button" className="btn btn-outline" onClick={() => onOpen(i, 'complete')}>Complete</button>
                    <button type="button" className="btn" onClick={() => onOpen(i, 'reschedule')}>Reschedule</button>
                  </>}
            </div>
          </div>
        )
      })}
    </section>
  )
}

export default function MyActions() {
  const { user } = useSession()
  const [scope, setScope] = useState<Scope>('me')
  const [panel, setPanel] = useState<{ item: ActionItem; mode: Mode } | null>(null)
  const [toast, setToast] = useState('')
  const [leaving, setLeaving] = useState<string | null>(null)
  const { data, error, loading, reload } = useLoad(() => api<ActionsResponse>('/actions', { params: { scope } }), [scope])
  const manager = user.role !== 'salesperson'
  const open = (item: ActionItem, mode: Mode) => setPanel({ item, mode })

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Actions</h1>
          <p>Completing an action asks for the next one. Overdue actions stay here until done, rescheduled or the record is closed.</p>
        </div>
        {manager && <Segmented<Scope> label="Whose actions" value={scope} onChange={setScope}
          options={[{ value: 'me', label: 'My actions' }, { value: 'team', label: 'Team (manager view)' }]} />}
      </div>
      {toast && <Banner onClose={() => setToast('')}>{toast}</Banner>}
      <ErrorBanner error={error} />
      {loading && !data && <div className="loading" data-label="Loading actions…">Loading actions…</div>}
      {data && <>
        <section className="tiles" aria-label="Summary">
          <div className="tile tile-badged"><span className="tile-badge tone-red" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0" /></svg></span><span className="k">Overdue</span><span className="v" style={{ color: data.counts.overdue ? 'var(--red-ink)' : undefined }}><CountUp value={data.counts.overdue} /></span><span className="s">{data.counts.escalated} escalated</span></div>
          <div className="tile tile-badged"><span className="tile-badge tone-amber" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" /></svg></span><span className="k">Due today</span><span className="v"><CountUp value={data.counts.today} /></span><span className="s">{fmtDate(data.as_of)}</span></div>
          <div className="tile tile-badged"><span className="tile-badge tone-blue" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" /></svg></span><span className="k">Next 7 days</span><span className="v"><CountUp value={data.counts.next_7_days} /></span><span className="s">Upcoming actions</span></div>
          <div className="tile tile-badged"><span className="tile-badge tone-purple" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10ZM2 21c0-3 1.9-5.4 5.1-6" /></svg></span><span className="k">Nurture revisits</span><span className="v" style={{ color: 'var(--purple-ink)' }}><CountUp value={data.counts.nurture} /></span><span className="s">Excluded from active forecast</span></div>
        </section>
        {panel && <ActionPanel key={`${panel.item.id}-${panel.mode}`} item={panel.item} mode={panel.mode} onCancel={() => setPanel(null)}
          onDone={(msg) => {
            // Let the handled row slide out before the list refreshes.
            setLeaving(`${panel.item.kind}-${panel.item.id}`)
            setPanel(null)
            setToast(msg)
            window.setTimeout(() => { setLeaving(null); void reload() }, 280)
          }} />}
        <Section title="Overdue" note="Stays until completed, rescheduled or closed" tone={{ bg: 'var(--red-soft)', fg: 'var(--red-ink)' }} items={data.overdue} team={scope === 'team'} onOpen={open} leaving={leaving} />
        <Section title="Due today" note="Reminder on the due date" tone={{ bg: 'var(--amber-soft)', fg: 'var(--amber-ink)' }} items={data.today} team={scope === 'team'} onOpen={open} leaving={leaving} />
        <Section title="Upcoming" note="Next actions after today" tone={{ bg: 'var(--paper-row)', fg: 'var(--ink)' }} items={data.upcoming} team={scope === 'team'} onOpen={open} leaving={leaving} />
        <Section title="Nurture revisits" note="Routine reminders paused; one reminder on the revisit date" tone={{ bg: 'var(--purple-soft)', fg: 'var(--purple-ink)' }} items={data.nurture} team={scope === 'team'} onOpen={open} leaving={leaving} />
      </>}
    </>
  )
}
