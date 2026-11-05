// Everyone involved in a deal (CRM review §4.3): the primary contact plus
// other buying contacts with a role. Add from the company's contacts.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import type { DealContact, Prospect } from '../types'
import { Avatar } from '../theme'
import { ErrorBanner, SelectField, TextField } from '../ui'

const ROLES = ['Decision maker', 'Champion', 'Influencer', 'Budget holder', 'User', 'Technical evaluator', 'Procurement']

export default function DealContacts({ dealId, contacts, candidates, accountName, canEdit, onChange }: {
  dealId: string; contacts: DealContact[]; candidates: Prospect[]; accountName?: string; canEdit: boolean; onChange: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const onDeal = new Set(contacts.map((c) => c.id))
  const options = candidates.filter((p) => !onDeal.has(p.id)).map((p) => ({ value: p.id, label: p.job_title ? `${p.full_name} · ${p.job_title}` : p.full_name }))

  async function add() {
    if (!pick) return
    try {
      await api(`/opportunities/${dealId}/contacts`, { method: 'POST', body: { prospect_id: pick, role: role === 'Other' ? custom : role } })
      setPick(null); setRole(null); setCustom(''); setAdding(false); onChange()
    } catch (e) { setError(e as ApiError) }
  }
  async function remove(id: string) {
    try { await api(`/opportunities/${dealId}/contacts/${id}`, { method: 'DELETE' }); onChange() } catch (e) { setError(e as ApiError) }
  }

  return (
    <section className="card" aria-label="Deal contacts">
      <div className="card-head">
        <h2>Contacts <span className="muted" style={{ fontWeight: 500 }}>· {contacts.length}</span></h2>
        {canEdit && !adding && <button type="button" className="btn btn-outline" onClick={() => setAdding(true)}>+ Add</button>}
      </div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {contacts.length === 0 && <p className="muted small" style={{ margin: 0 }}>No contacts on this deal yet. Set a primary contact or add people involved in the decision.</p>}
      {contacts.map((c) => (
        <div className="assoc-row" key={c.id}>
          <Avatar name={c.full_name} size={30} />
          <div className="who">
            <Link to={`/contacts/${c.id}`}>{c.full_name}</Link>
            <span className="small muted">{[c.role, c.job_title].filter(Boolean).join(' · ') || c.status}</span>
          </div>
          {canEdit && !c.is_primary && <button type="button" className="btn" aria-label={`Remove ${c.full_name} from the deal`} onClick={() => void remove(c.id)}>Remove</button>}
        </div>
      ))}
      {adding && (
        <div className="grid-fields" style={{ gridTemplateColumns: '1fr' }}>
          <SelectField label={`Contact at ${accountName || 'the company'}`} value={pick} onChange={setPick} options={options}
            placeholder={options.length ? 'Choose…' : 'No other contacts at this company'} />
          <SelectField label="Role" value={role} onChange={setRole} options={[...ROLES, 'Other']} placeholder="Optional" />
          {role === 'Other' && <TextField label="Role name" value={custom} onChange={(v) => setCustom(v.slice(0, 60))} />}
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={!pick} onClick={() => void add()}>Add to deal</button>
            <button type="button" className="btn" onClick={() => { setAdding(false); setError(null) }}>Cancel</button>
            <Link className="small" to="/contacts">New contact…</Link>
          </div>
        </div>
      )}
    </section>
  )
}
