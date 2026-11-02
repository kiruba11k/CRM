// Finishing a drag-and-drop stage move. The CRM's stage rules still apply:
// when the new stage needs details the deal doesn't have yet (a value and
// risk rating from Qualified, a won value and date, a lost reason…), this
// dialog asks for exactly those fields, then saves the move.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { todayIso } from '../format'
import { useSession } from '../session'
import type { FieldErrors, FormValue, FormValues, Opportunity } from '../types'
import { ErrorBanner, NextActionFields, SelectField, TextField } from '../ui'

const NEXT = ['next_action_code', 'next_action_other', 'next_action_due']

export function initialFor(o: Opportunity, errors: FieldErrors): FormValues {
  const v: FormValues = {}
  for (const f of Object.keys(errors)) {
    if (f === 'won_date' || f === 'lost_date') v[f] = todayIso()
    else if (f === 'actual_value') v[f] = o.estimated_value
    else v[f] = (o as unknown as Record<string, FormValue>)[f] ?? null
  }
  if (NEXT.some((f) => f in errors)) for (const f of NEXT) v[f] = (o as unknown as Record<string, FormValue>)[f] ?? null
  return v
}

export default function StageMoveDialog({ opp, stage, errors: firstErrors, onDone, onCancel }: {
  opp: Opportunity; stage: string; errors: FieldErrors; onDone: (o: Opportunity) => void; onCancel: () => void
}) {
  const { lists } = useSession()
  const [form, setForm] = useState<FormValues>(() => initialFor(opp, firstErrors))
  const [error, setError] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)
  const errors = error?.fieldErrors || firstErrors
  const set = (k: string, v: FormValue) => setForm((f) => ({ ...f, [k]: v }))
  const has = (f: string) => f in form
  const known = new Set(['estimated_value', 'risk_rating', 'high_risk_reason', 'risk_mitigation', 'expected_close', 'proposal_due',
    'actual_value', 'won_date', 'lost_reason', 'lost_date', ...NEXT])
  const other = Object.keys(firstErrors).filter((f) => !known.has(f))

  async function save() {
    setSaving(true)
    setError(null)
    try {
      onDone(await api<Opportunity>(`/opportunities/${opp.id}`, { method: 'PATCH', body: { stage, ...form } }))
    } catch (e) {
      const err = e as ApiError
      // A follow-on rule (e.g. High risk now needs a reason): add those fields.
      setForm((f) => ({ ...initialFor(opp, err.fieldErrors), ...f }))
      setError(err)
    } finally { setSaving(false) }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Move to ${stage}`}>
        <div>
          <h2>Move “{opp.name}” to {stage}</h2>
          <span className="muted small">{stage} needs a few details first. Nothing has changed yet.</span>
        </div>
        <ErrorBanner error={error && !Object.keys(error.fieldErrors).length ? error : null} />
        <div className="grid-fields">
          {has('estimated_value') && <TextField label={`Estimated value (${opp.currency})`} required value={form.estimated_value} onChange={(v) => set('estimated_value', v)} error={errors.estimated_value} />}
          {has('risk_rating') && <SelectField label="Risk rating" required value={form.risk_rating} onChange={(v) => set('risk_rating', v)} error={errors.risk_rating}
            options={lists.risk_ratings.filter((r) => r !== 'Unassessed')} placeholder="Choose…" />}
          {(has('high_risk_reason') || form.risk_rating === 'High') && <>
            <TextField label="High-risk reason" required value={form.high_risk_reason} onChange={(v) => set('high_risk_reason', v)} error={errors.high_risk_reason} />
            <TextField label="Mitigation / next action" required value={form.risk_mitigation} onChange={(v) => set('risk_mitigation', v)} error={errors.risk_mitigation} />
          </>}
          {has('expected_close') && <TextField label="Expected close date" type="date" required value={form.expected_close} onChange={(v) => set('expected_close', v || null)} error={errors.expected_close} />}
          {has('proposal_due') && <TextField label="Proposal date" type="date" required value={form.proposal_due} onChange={(v) => set('proposal_due', v || null)} error={errors.proposal_due} />}
          {has('actual_value') && <TextField label={`Actual contract value (${opp.currency})`} required value={form.actual_value} onChange={(v) => set('actual_value', v)} error={errors.actual_value} />}
          {has('won_date') && <TextField label="Won date" type="date" required value={form.won_date} onChange={(v) => set('won_date', v || null)} error={errors.won_date} />}
          {has('lost_reason') && <SelectField label="Lost reason" required value={form.lost_reason} onChange={(v) => set('lost_reason', v)} options={lists.lost_reasons} placeholder="Choose…" error={errors.lost_reason} />}
          {has('lost_date') && <TextField label="Lost date" type="date" required value={form.lost_date} onChange={(v) => set('lost_date', v || null)} error={errors.lost_date} />}
          {NEXT.some(has) && <NextActionFields value={form} onChange={setForm} errors={errors} />}
        </div>
        {other.length > 0 && (
          <p className="small" style={{ margin: 0 }}>Also needed: {other.map((f) => firstErrors[f]).join(' ')} <Link to={`/opportunities/${opp.id}`}>Open the deal</Link></p>
        )}
        <div className="row">
          <button type="button" className="btn btn-dark" disabled={saving} onClick={() => void save()}>{saving ? 'Moving…' : `Move to ${stage}`}</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
