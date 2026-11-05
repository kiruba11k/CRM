// Settings → Automations: "when … then …" rules (CRM review P2).
import { useEffect, useState } from 'react'
import { ApiError, api } from '../api'
import { can, useSession } from '../session'
import type { FormValues } from '../types'
import { ErrorBanner, NextActionFields, OwnerField, SelectField, TextField } from '../ui'
import { useRecordLists } from './RecordLists'

type Entity = 'prospect' | 'opportunity'
type Trigger = 'created' | 'stage_changed' | 'status_changed'
type Action = 'set_next_action' | 'assign_owner' | 'add_to_list' | 'log_note'
interface Rule { id: string; name: string; entity: Entity; trigger: Trigger; trigger_value: string | null; action: Action; params: Record<string, unknown>; active: boolean; run_count: number; last_run_at: string | null }

const ACTION_LABEL: Record<Action, string> = { set_next_action: 'Set the next action', assign_owner: 'Assign an owner', add_to_list: 'Add to a list', log_note: 'Log a note' }

export default function AutomationsSettings() {
  const { user, lists, users } = useSession()
  const admin = can(user, 'manage_settings')
  const [rules, setRules] = useState<Rule[]>([])
  const [f, setF] = useState<FormValues>({ entity: 'opportunity', trigger: 'stage_changed', action: 'set_next_action', days: '3' })
  const [error, setError] = useState<ApiError | null>(null)
  const listsFor = useRecordLists(f.entity === 'prospect' ? 'prospects' : 'opportunities')
  useEffect(() => { api<Rule[]>('/automations').then(setRules).catch((e) => setError(e as ApiError)) }, [])

  const when = (r: Pick<Rule, 'entity' | 'trigger' | 'trigger_value'>) => {
    const thing = r.entity === 'opportunity' ? 'a deal' : 'a contact'
    if (r.trigger === 'created') return `When ${thing} is created`
    return `When ${thing} ${r.trigger === 'stage_changed' ? 'moves to' : 'gets status'} ${r.trigger_value || (r.trigger === 'stage_changed' ? 'any stage' : 'any status')}`
  }
  const then = (r: Rule) => {
    const p = r.params
    if (r.action === 'set_next_action') return `set the next action to “${lists.next_actions.find((n) => n.code === p.code)?.label || p.code}”, due in ${p.days} business day${p.days === 1 ? '' : 's'}`
    if (r.action === 'assign_owner') return `assign it to ${users.find((u) => u.id === p.user_id)?.name || 'someone'}`
    if (r.action === 'add_to_list') return 'add it to a list'
    return `log the note “${p.text}”`
  }

  async function add() {
    setError(null)
    const params: Record<string, unknown> = f.action === 'set_next_action' ? { code: f.next_action_code, other: f.next_action_other, days: Number(f.days) }
      : f.action === 'assign_owner' ? { user_id: f.owner_id } : f.action === 'add_to_list' ? { list_id: f.list_id } : { text: f.text }
    try {
      setRules(await api<Rule[]>('/automations', { method: 'POST', body: { name: f.name, entity: f.entity, trigger: f.trigger, trigger_value: f.trigger_value || null, action: f.action, params } }))
      setF({ entity: f.entity, trigger: f.trigger, action: f.action, days: '3' })
    } catch (e) { setError(e as ApiError) }
  }
  async function toggle(r: Rule) {
    setRules(rules.map((x) => (x.id === r.id ? { ...x, active: !r.active } : x)))
    try { setRules(await api<Rule[]>(`/automations/${r.id}`, { method: 'PATCH', body: { active: !r.active } })) } catch (e) { setError(e as ApiError) }
  }
  async function remove(r: Rule) {
    if (!confirm(`Delete the automation “${r.name}”?`)) return
    try { setRules(await api<Rule[]>(`/automations/${r.id}`, { method: 'DELETE' })) } catch (e) { setError(e as ApiError) }
  }

  const errs = error?.fieldErrors || {}
  const deal = f.entity === 'opportunity'
  return (
    <section className="card" aria-label="Automations">
      <div className="card-head"><div><h2>Automations</h2><span className="muted small">Simple rules that save routine clicks. Each run is noted on the record’s timeline.</span></div></div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {rules.length === 0 && <p className="muted small" style={{ margin: 0 }}>No automations yet. Example: when a deal moves to Proposal submitted, set the next action to “Follow up on proposal” in 5 business days.</p>}
      {rules.map((r) => (
        <div className="list-row" key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
          <span style={{ flex: '1 1 340px' }}><strong>{r.name}</strong><br /><span className="small">{when(r)}, {then(r)}.</span>
            <br /><span className="muted small">Ran {r.run_count} time{r.run_count === 1 ? '' : 's'}</span></span>
          {admin ? <>
            <label className="check"><input type="checkbox" checked={r.active} onChange={() => void toggle(r)} /> {r.active ? 'On' : 'Paused'}</label>
            <button type="button" className="btn" onClick={() => void remove(r)}>Delete</button>
          </> : <span className={`pill pill-${r.active ? 'teal' : 'grey'}`}>{r.active ? 'On' : 'Paused'}</span>}
        </div>
      ))}
      {admin && <>
        <h3 style={{ margin: '8px 0 0' }}>New automation</h3>
        <div className="grid-fields">
          <TextField label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v.slice(0, 80) })} placeholder="e.g. Proposal follow-up" error={errs.name} />
          <SelectField label="Applies to" required value={f.entity as string} onChange={(v) => setF({ ...f, entity: v, trigger: v === 'prospect' ? 'status_changed' : 'stage_changed', trigger_value: null, list_id: null })}
            options={[{ value: 'opportunity', label: 'Deals' }, { value: 'prospect', label: 'Contacts' }]} />
          <SelectField label="When" required value={f.trigger as string} onChange={(v) => setF({ ...f, trigger: v, trigger_value: null })} error={errs.trigger}
            options={[{ value: 'created', label: deal ? 'A deal is created' : 'A contact is created' }, deal ? { value: 'stage_changed', label: 'The stage changes' } : { value: 'status_changed', label: 'The status changes' }]} />
          {f.trigger !== 'created' && <SelectField label={deal ? 'To stage' : 'To status'} value={f.trigger_value as string | null} onChange={(v) => setF({ ...f, trigger_value: v })} placeholder="Any"
            options={deal ? lists.stages.map((s) => s.name) : lists.prospect_statuses} error={errs.trigger_value} />}
          <SelectField label="Then" required value={f.action as string} onChange={(v) => setF({ ...f, action: v })} options={(Object.keys(ACTION_LABEL) as Action[]).map((a) => ({ value: a, label: ACTION_LABEL[a] }))} />
          {f.action === 'set_next_action' && <>
            <NextActionFields value={f} onChange={setF} withDue={false} errors={{ next_action_code: errs['params.code'] }} />
            <SelectField label="Due in" required value={String(f.days)} onChange={(v) => setF({ ...f, days: v })} error={errs['params.days']}
              options={[0, 1, 2, 3, 5, 7, 10, 15, 20].map((n) => ({ value: String(n), label: n === 0 ? 'Same day' : `${n} business day${n === 1 ? '' : 's'}` }))} />
          </>}
          {f.action === 'assign_owner' && <OwnerField label="Assign to" value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} error={errs['params.user_id']} />}
          {f.action === 'add_to_list' && <SelectField label="List" required value={f.list_id as string | null} onChange={(v) => setF({ ...f, list_id: v })} placeholder={listsFor.items.length ? 'Choose…' : 'Make a list first (tick rows → Add to list)'}
            options={listsFor.items.map((l) => ({ value: l.id, label: l.name }))} error={errs['params.list_id']} />}
          {f.action === 'log_note' && <TextField label="Note" required value={f.text} onChange={(v) => setF({ ...f, text: v.slice(0, 300) })} error={errs['params.text']} />}
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={!String(f.name || '').trim()} onClick={() => void add()}>Add automation</button>
          <span className="muted small">A next action someone sets in the same save is kept; closed and nurtured records are skipped.</span>
        </div>
      </>}
      {!admin && <span className="muted small">Only admins can add or change automations.</span>}
    </section>
  )
}
