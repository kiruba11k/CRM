// Account page: people at this company the team has emailed (auto-logged
// by email domain) who aren't prospects yet, with one-click "Add as prospect".
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate } from '../format'
import type { FormValues } from '../types'
import { ErrorBanner, NextActionFields, TextField, useLoad } from '../ui'
import { useToast } from './Toast'

interface Contact { email: string; emails: number; last_at: string; colleagues: string[] | null }

// anna.holm@x.com -> "Anna Holm"
const guessName = (email: string) => email.split('@')[0].split(/[._-]+/).filter((w) => w && !/\d/.test(w))
  .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

function AddForm({ c, accountId, onDone, onCancel }: { c: Contact; accountId: string; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<FormValues>({ full_name: guessName(c.email), job_title: '', next_action_code: null, next_action_due: null })
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const save = async () => {
    setBusy(true); setError(null)
    try {
      await api('/prospects', { method: 'POST', body: { ...f, job_title: f.job_title || null, email: c.email, account_id: accountId, source: 'Inbound' } })
      toast(`${f.full_name} added as a prospect. Earlier emails stay on the account; new ones log on them.`)
      onDone()
    } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
  }
  return (
    <div className="person-form">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <TextField label="Full name" required value={f.full_name} onChange={(v) => setF({ ...f, full_name: v })} />
      <TextField label="Job title" value={f.job_title} onChange={(v) => setF({ ...f, job_title: v })} />
      <NextActionFields value={f} onChange={setF} errors={error?.fieldErrors} />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-dark" disabled={busy || !String(f.full_name || '').trim()} onClick={() => void save()}>{busy ? 'Adding…' : 'Add prospect'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function EmailContacts({ accountId, onAdded }: { accountId: string; onAdded: () => void }) {
  const list = useLoad(() => api<Contact[]>(`/accounts/${accountId}/email-contacts`), [accountId])
  const [open, setOpen] = useState<string | null>(null)
  const rows = list.data || []
  if (!rows.length) return null
  return (
    <section className="card" aria-label="People you email here">
      <div className="card-head"><h2>People you email here</h2><span className="muted small">not prospects yet</span></div>
      <ErrorBanner error={list.error} />
      {rows.map((c) => (
        <div key={c.email} className="contact-row">
          <div style={{ minWidth: 0 }}>
            <strong className="contact-email">{c.email}</strong>
            <span className="muted small">{c.emails} email{c.emails === 1 ? '' : 's'} · last {fmtDate(c.last_at)}{c.colleagues?.length ? ` · ${c.colleagues.join(', ')}` : ''}</span>
          </div>
          {open !== c.email && <button type="button" className="btn btn-outline" onClick={() => setOpen(c.email)}>Add as prospect</button>}
          {open === c.email && <AddForm c={c} accountId={accountId} onCancel={() => setOpen(null)} onDone={() => { setOpen(null); void list.reload(); onAdded() }} />}
        </div>
      ))}
      <span className="muted small">Found by Gmail auto-logging from this company’s email domain.</span>
    </section>
  )
}
