// §5.3 / §7 My Actions: overdue, today, upcoming, nurture revisits.
// Completing an action asks for the next one; nurture revisits end in
// reactivate, extend or mark lost.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { fmtDate } from '../format.js'
import { useSession } from '../session.jsx'
import { Banner, ErrorBanner, NextActionFields, Segmented, SelectField, TextField, useLoad } from '../ui.jsx'

const KIND = {
  prospect: { label: 'Prospect', pill: 'blue', path: '/prospects/' },
  opportunity: { label: 'Opportunity', pill: 'teal', path: '/opportunities/' },
  nurture: { label: 'Nurture revisit', pill: 'purple', path: '/opportunities/' },
}

function ActionPanel({ item, mode, onDone, onCancel }) {
  const { lists } = useSession()
  const [form, setForm] = useState(mode === 'reschedule'
    ? { next_action_code: item.code, next_action_other: item.other, next_action_due: null }
    : { next_action_code: null, next_action_other: null, next_action_due: null })
  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState('reactivate')
  const [extra, setExtra] = useState({ nurture_until: null, lost_reason: null, lost_date: null })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const base = item.kind === 'prospect' ? `/prospects/${item.id}` : `/opportunities/${item.id}`

  async function save() {
    setSaving(true)
    setError(null)
    try {
      let msg
      if (mode === 'revisit') {
        const body = { outcome }
        if (outcome === 'reactivate') Object.assign(body, form)
        if (outcome === 'extend') body.nurture_until = extra.nurture_until
        if (outcome === 'lost') Object.assign(body, { lost_reason: extra.lost_reason, lost_date: extra.lost_date || undefined })
        await api(`${base}/revisit`, { method: 'POST', body })
        msg = outcome === 'reactivate' ? `${item.title} reactivated at its original stage.` : outcome === 'extend' ? `Nurture extended to ${fmtDate(extra.nurture_until)}.` : `${item.title} marked Lost. Reminders stopped.`
      } else if (mode === 'complete') {
        await api(`${base}/complete-action`, { method: 'POST', body: { ...form, note: note || undefined } })
        msg = `“${item.label}” logged as done. Next action saved.`
      } else {
        await api(base, { method: 'PATCH', body: form })
        msg = `Rescheduled to ${fmtDate(form.next_action_due)}.`
      }
      onDone(msg)
    } catch (e) {
      setError(e)
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
        <Segmented label="Revisit outcome" value={outcome} onChange={setOutcome}
          options={[{ value: 'reactivate', label: 'Reactivate' }, { value: 'extend', label: 'Extend nurture' }, { value: 'lost', label: 'Mark lost' }]} />
      )}
      <ErrorBanner error={error} />
      <div className="grid-fields">
        {(mode !== 'revisit' || outcome === 'reactivate') && <NextActionFields value={form} onChange={setForm} errors={errors} />}
        {mode === 'complete' && <TextField label="What happened? (optional)" value={note} onChange={setNote} />}
        {mode === 'revisit' && outcome === 'extend' && (
          <TextField label="New revisit date" type="date" required value={extra.nurture_until} onChange={(v) => setExtra({ ...extra, nurture_until: v })} error={errors.nurture_until} />
        )}
        {mode === 'revisit' && outcome === 'lost' && <>
          <SelectField label="Lost reason" required value={extra.lost_reason} onChange={(v) => setExtra({ ...extra, lost_reason: v })} options={lists.lost_reasons} placeholder="Choose…" error={errors.lost_reason} />
          <TextField label="Lost date" type="date" value={extra.lost_date} onChange={(v) => setExtra({ ...extra, lost_date: v })} hint="Defaults to today" />
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

function Section({ title, note, tone, items, team, onOpen }) {
  return (
    <section className="section" aria-label={title}>
      <div className="section-head" style={{ background: tone.bg }}>
        <h2 style={{ color: tone.fg }}>{title} <span style={{ fontWeight: 500 }}>· {items.length}</span></h2>
        <span className="muted small">{note}</span>
      </div>
      {items.length === 0 && <div className="action-row muted">Nothing here.</div>}
      {items.map((i) => {
        const k = KIND[i.kind]
        const dueText = i.kind === 'nurture'
          ? `Revisit ${fmtDate(i.due)}${i.days_until !== null ? ` · in ${i.days_until} day${i.days_until === 1 ? '' : 's'}` : ''}`
          : i.business_days_overdue !== undefined
            ? `Due ${fmtDate(i.due)} · ${i.business_days_overdue} business day${i.business_days_overdue === 1 ? '' : 's'} overdue`
            : i.days_until !== undefined ? `Due ${fmtDate(i.due)} · in ${i.days_until} day${i.days_until === 1 ? '' : 's'}` : 'Due today'
        return (
          <div className="action-row" key={`${i.kind}-${i.id}`}>
            <span className={`pill pill-${k.pill}`}>{k.label}</span>
            <div className="who">
              <Link to={k.path + i.id} style={{ fontWeight: 600 }}>{i.title}</Link>
              <span className="muted small">{i.account_name || 'No account yet'}{i.nurture_reason ? ` · ${i.nurture_reason}` : ''}</span>
            </div>
            <div className="what">
              <span style={{ fontWeight: 600 }}>{i.kind === 'nurture' ? 'Revisit: ' : ''}{i.label || '—'}</span>
              <span className="small" style={{ fontWeight: 600, color: tone.fg }}>{dueText}{team ? ` · ${i.owner_name}` : ''}</span>
            </div>
            {i.escalated && <span className="pill pill-red">Escalated to manager</span>}
            <div className="row">
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
  const [scope, setScope] = useState('me')
  const [panel, setPanel] = useState(null)
  const [toast, setToast] = useState('')
  const { data, error, loading, reload } = useLoad(() => api('/actions', { params: { scope } }), [scope])
  const manager = user.role !== 'salesperson'

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Actions</h1>
          <p>Completing an action asks for the next one. Overdue actions stay here until done, rescheduled or the record is closed.</p>
        </div>
        {manager && <Segmented label="Whose actions" value={scope} onChange={setScope}
          options={[{ value: 'me', label: 'My actions' }, { value: 'team', label: 'Team (manager view)' }]} />}
      </div>
      {toast && <Banner onClose={() => setToast('')}>{toast}</Banner>}
      <ErrorBanner error={error} />
      {loading && !data && <div className="loading">Loading actions…</div>}
      {data && <>
        <section className="tiles" aria-label="Summary">
          <div className="tile"><span className="k">Overdue</span><span className="v" style={{ color: data.counts.overdue ? 'var(--red-ink)' : undefined }}>{data.counts.overdue}</span><span className="s">{data.counts.escalated} escalated</span></div>
          <div className="tile"><span className="k">Due today</span><span className="v">{data.counts.today}</span><span className="s">{fmtDate(data.as_of)}</span></div>
          <div className="tile"><span className="k">Next 7 days</span><span className="v">{data.counts.next_7_days}</span><span className="s">Upcoming actions</span></div>
          <div className="tile"><span className="k">Nurture revisits</span><span className="v" style={{ color: 'var(--purple-ink)' }}>{data.counts.nurture}</span><span className="s">Excluded from active forecast</span></div>
        </section>
        {panel && <ActionPanel key={`${panel.item.id}-${panel.mode}`} item={panel.item} mode={panel.mode} onCancel={() => setPanel(null)}
          onDone={(msg) => { setPanel(null); setToast(msg); reload() }} />}
        <Section title="Overdue" note="Stays until completed, rescheduled or closed" tone={{ bg: 'var(--red-soft)', fg: 'var(--red-ink)' }} items={data.overdue} team={scope === 'team'} onOpen={(item, mode) => setPanel({ item, mode })} />
        <Section title="Due today" note="Reminder on the due date" tone={{ bg: 'var(--amber-soft)', fg: 'var(--amber-ink)' }} items={data.today} team={scope === 'team'} onOpen={(item, mode) => setPanel({ item, mode })} />
        <Section title="Upcoming" note="Next actions after today" tone={{ bg: 'var(--paper-row)', fg: 'var(--ink)' }} items={data.upcoming} team={scope === 'team'} onOpen={(item, mode) => setPanel({ item, mode })} />
        <Section title="Nurture revisits" note="Routine reminders paused; one reminder on the revisit date" tone={{ bg: 'var(--purple-soft)', fg: 'var(--purple-ink)' }} items={data.nurture} team={scope === 'team'} onOpen={(item, mode) => setPanel({ item, mode })} />
      </>}
    </>
  )
}
