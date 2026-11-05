// Completing a next action (CRM review §4.5): pick what happened, and the
// form suggests the next step. "Not interested" closes the record (Lost /
// Disqualified); "Moved to nurture" puts it on nurture.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate } from '../format'
import { useSession } from '../session'
import type { FormValues } from '../types'
import { ErrorBanner, NextActionFields, SelectField, TextField } from '../ui'

export type OutcomeCode = 'connected' | 'no_response' | 'meeting_booked' | 'proposal_requested' | 'not_interested' | 'moved_to_nurture'
export const OUTCOMES: { code: OutcomeCode; label: string; tone: string }[] = [
  { code: 'connected', label: 'Connected', tone: 'teal' },
  { code: 'no_response', label: 'No response', tone: 'grey' },
  { code: 'meeting_booked', label: 'Meeting booked', tone: 'blue' },
  { code: 'proposal_requested', label: 'Proposal requested', tone: 'purple' },
  { code: 'not_interested', label: 'Not interested', tone: 'red' },
  { code: 'moved_to_nurture', label: 'Moved to nurture', tone: 'amber' },
]
export const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.code, o.label])) as Record<string, string>
export const OUTCOME_TONE = Object.fromEntries(OUTCOMES.map((o) => [o.code, o.tone])) as Record<string, string>

// Suggested next step for each outcome: action code and days ahead.
const SUGGEST: Partial<Record<OutcomeCode, [string, number]>> = {
  connected: ['05', 2], no_response: ['04', 3], meeting_booked: ['06', 7], proposal_requested: ['07', 3], moved_to_nurture: ['16', 90],
}

function inDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  if (n < 30) { while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1) } // skip weekends
  return d.toISOString().slice(0, 10)
}

export default function CompleteAction({ kind, id, title, current, onDone, onCancel, closeLink }: {
  kind: 'prospect' | 'opportunity'; id: string; title: string; current: string | null
  onDone: (msg: string) => void; onCancel: () => void; closeLink?: React.ReactNode
}) {
  const { lists } = useSession()
  const [outcome, setOutcome] = useState<OutcomeCode | null>(null)
  const [form, setForm] = useState<FormValues>({ next_action_code: null, next_action_other: null, next_action_due: null })
  const [extra, setExtra] = useState<FormValues>({})
  const [note, setNote] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)
  const deal = kind === 'opportunity'
  const closes = outcome === 'not_interested'
  const dealNurture = deal && outcome === 'moved_to_nurture'

  function pick(o: OutcomeCode) {
    setOutcome(o)
    setError(null)
    const s = SUGGEST[o]
    if (deal && o === 'moved_to_nurture') {
      setExtra({ nurture_until: inDays(90), nurture_next_action_code: '17', nurture_reason: null })
    } else if (s) {
      setForm({ ...form, next_action_code: s[0], next_action_other: null, next_action_due: inDays(s[1]) })
    }
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const body: FormValues = { outcome, note: note || undefined }
      if (closes) Object.assign(body, deal ? { lost_reason: extra.lost_reason } : { disqualified_reason: extra.disqualified_reason || note || undefined })
      else if (dealNurture) Object.assign(body, extra)
      else Object.assign(body, form)
      await api(`/${deal ? 'opportunities' : 'prospects'}/${id}/complete-action`, { method: 'POST', body })
      onDone(closes ? `${title} ${deal ? 'marked Lost' : 'disqualified'}. Reminders stopped.`
        : dealNurture ? `${title} moved to nurture until ${fmtDate(extra.nurture_until as string)}.`
        : `“${current || 'Action'}” logged as done${outcome ? ` (${OUTCOME_LABEL[outcome]})` : ''}. Next action saved.`)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setSaving(false)
    }
  }

  const errors = error?.fieldErrors || {}
  return (
    <section className="card strong" aria-label="Complete the action">
      <div>
        <h2>Done. What happened?</h2>
        <span className="muted small">{title} · current action: {current || '—'}</span>
      </div>
      <div className="outcome-chips" role="group" aria-label="Outcome">
        {OUTCOMES.map((o) => (
          <button key={o.code} type="button" className={`outcome-chip tone-${o.tone}`} aria-pressed={outcome === o.code} onClick={() => pick(o.code)}>{o.label}</button>
        ))}
      </div>
      <ErrorBanner error={error} />
      <div className="grid-fields">
        {closes && (deal
          ? <SelectField label="Lost reason" required value={extra.lost_reason as string | null} onChange={(v) => setExtra({ ...extra, lost_reason: v })} options={lists.lost_reasons} placeholder="Choose…" error={errors.lost_reason} />
          : <TextField label="Why not interested?" value={(extra.disqualified_reason as string) || ''} onChange={(v) => setExtra({ ...extra, disqualified_reason: v })} hint="Saved as the disqualification reason" />)}
        {dealNurture && <>
          <SelectField label="Nurture reason" required value={extra.nurture_reason as string | null} onChange={(v) => setExtra({ ...extra, nurture_reason: v })} options={lists.nurture_reasons} placeholder="Choose…" error={errors.nurture_reason} />
          <TextField label="Revisit on" type="date" required value={extra.nurture_until as string | null} onChange={(v) => setExtra({ ...extra, nurture_until: v || null })} error={errors.nurture_until} />
          <NextActionFields value={extra} onChange={setExtra} errors={errors} prefix="nurture_next_action" withDue={false} />
        </>}
        {!closes && !dealNurture && <NextActionFields value={form} onChange={setForm} errors={errors} withCalendar />}
        <TextField label="Notes (optional)" value={note} onChange={setNote} />
      </div>
      {outcome && SUGGEST[outcome] && !dealNurture && <span className="muted small">Next action suggested from the outcome. Change it if needed.</span>}
      {!deal && outcome === 'moved_to_nurture' && <span className="muted small">Status becomes Nurture. Keep a reconnect action so it comes back.</span>}
      <div className="row">
        <button type="button" className={`btn ${closes ? 'btn-danger' : 'btn-dark'}`} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : closes ? (deal ? 'Mark Lost' : 'Disqualify') : dealNurture ? 'Move to nurture' : 'Save next action'}
        </button>
        {closeLink}
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}
