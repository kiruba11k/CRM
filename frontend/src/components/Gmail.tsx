// §6.2 Gmail in context: search and compose links that carry the record's
// account / opportunity, and Gmail threads a user explicitly links to the
// record. Nothing is read from Gmail: only the link and a label are stored.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate } from '../format'
import { useSession } from '../session'
import type { EmailThread } from '../types'
import { ErrorBanner, TextField, useLoad } from '../ui'

const GMAIL = 'https://mail.google.com/mail/u/0/'

function searchQuery(domain: string | null, emails: string[]): string | null {
  if (domain) return `from:(@${domain}) OR to:(@${domain})`
  if (emails.length) return `from:(${emails.join(' OR ')}) OR to:(${emails.join(' OR ')})`
  return null
}

export function GmailCard({ entityType, entityId, emails, domain, subject, canEdit, onChange }: {
  entityType: EmailThread['entity_type']; entityId: string; emails: string[]; domain: string | null; subject: string; canEdit: boolean
  /** Called after a link or unlink, so the record's activity timeline refreshes. */
  onChange?: () => void
}) {
  const { user } = useSession()
  const threads = useLoad(() => api<EmailThread[]>('/email-threads', { params: { entity_type: entityType, entity_id: entityId } }), [entityType, entityId])
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const to = [...new Set(emails.filter(Boolean))].slice(0, 10)
  const q = searchQuery(domain, to)
  const compose = `https://mail.google.com/mail/?view=cm&fs=1${to.length ? `&to=${encodeURIComponent(to.join(','))}` : ''}&su=${encodeURIComponent(subject)}`

  async function link() {
    setError(null)
    try {
      await api('/email-threads', { method: 'POST', body: { entity_type: entityType, entity_id: entityId, url, label } })
      setUrl('')
      setLabel('')
      setAdding(false)
      void threads.reload()
      onChange?.()
    } catch (e) { setError(e as ApiError) }
  }
  const unlink = (t: EmailThread) => api(`/email-threads/${t.id}`, { method: 'DELETE' }).then(() => { void threads.reload(); onChange?.() }).catch((e: ApiError) => setError(e))
  const errors = error?.fieldErrors || {}

  return (
    <section className="card" aria-label="Gmail">
      <h2>Gmail</h2>
      <div className="row" style={{ gap: 8 }}>
        {q && <a className="btn btn-outline" href={`${GMAIL}#search/${encodeURIComponent(q)}`} target="_blank" rel="noreferrer">Search Gmail{domain ? ` for @${domain}` : ''}</a>}
        <a className="btn" href={compose} target="_blank" rel="noreferrer">Compose{to.length === 1 ? ` to ${to[0]}` : to.length ? ` to ${to.length} contacts` : ''}</a>
      </div>
      <span className="muted small">Compose opens with the subject “{subject}”.</span>

      <h3 className="small" style={{ margin: '4px 0 0' }}>Linked threads</h3>
      <ErrorBanner error={threads.error || (error && !Object.keys(errors).length ? error : null)} onClose={() => setError(null)} />
      {(threads.data || []).length === 0 && <p className="muted small" style={{ margin: 0 }}>None linked yet.</p>}
      {(threads.data || []).map((t) => (
        <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <a href={t.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{t.label}</a>
          <span className="small muted">Linked by {t.linked_by_name || '—'} · {fmtDate(t.linked_at)}
            {(t.linked_by === user.id || user.role !== 'salesperson') && <> · <button type="button" className="btn-link small" onClick={() => void unlink(t)}>Remove</button></>}
          </span>
        </div>
      ))}
      {canEdit && (adding ? (
        <>
          <TextField label="Gmail thread link" value={url} onChange={setUrl} placeholder="https://mail.google.com/mail/u/0/#inbox/…" error={errors.url}
            hint="Open the thread in Gmail and copy the address bar" />
          <TextField label="Label" value={label} onChange={setLabel} placeholder="e.g. Re: Q1 pilot scope" error={errors.label} />
          <div className="row">
            <button type="button" className="btn btn-dark" onClick={() => void link()}>Link thread</button>
            <button type="button" className="btn" onClick={() => { setAdding(false); setError(null) }}>Cancel</button>
          </div>
        </>
      ) : <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>+ Link a Gmail thread</button>)}
      <span className="muted small">Only the link, your label and who linked it are stored; no email content is copied into the CRM. A thread opens for people who have it in their own Gmail.</span>
    </section>
  )
}
