// Files & links on a deal or account: proposals, contracts, SOWs. Upload a
// file (up to 10 MB) or link a Google Drive / Docs file.
import { useRef, useState, type DragEvent } from 'react'
import { ApiError, api, downloadFile, uploadFile } from '../api'
import { fmtDate } from '../format'
import { can, useSession } from '../session'
import { ErrorBanner, useLoad } from '../ui'
import { useToast } from './Toast'

interface Attachment {
  id: string; kind: string; title: string; url: string | null; filename: string | null; content_type: string | null
  size_bytes: number | null; note: string | null; created_at: string; uploaded_by: string | null; uploaded_by_name: string | null
}
interface AttachmentList { kinds: string[]; max_bytes: number; extensions: string[]; items: Attachment[] }

const size = (b: number | null) => (b == null ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
function icon(a: Attachment): string {
  if (a.url) return a.url.includes('docs.google.com') || a.url.includes('drive.google.com') ? 'G' : '↗'
  const ext = (a.filename || '').split('.').pop()?.toUpperCase() || 'FILE'
  return ext.slice(0, 4)
}

export default function Attachments({ entityType, entityId, canEdit, onChange }: {
  entityType: 'opportunity' | 'account'; entityId: string; canEdit: boolean; onChange?: () => void
}) {
  const { user } = useSession()
  const toast = useToast()
  const list = useLoad(() => api<AttachmentList>('/attachments', { params: { entity_type: entityType, entity_id: entityId } }), [entityType, entityId])
  const [kind, setKind] = useState('Proposal')
  const [mode, setMode] = useState<null | 'link'>(null)
  const [link, setLink] = useState({ url: '', title: '' })
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const d = list.data
  const done = (msg: string) => { toast(msg); void list.reload(); onChange?.() }

  const send = async (files: FileList | null) => {
    if (!files?.length || !d) return
    setError(null)
    for (const f of Array.from(files)) {
      const ext = f.name.split('.').pop()?.toLowerCase() || ''
      if (!d.extensions.includes(ext)) { setError(new Error(`${f.name}: that file type isn’t allowed.`)); continue }
      if (f.size > d.max_bytes) { setError(new Error(`${f.name} is over 10 MB. Put it in Google Drive and add a link instead.`)); continue }
      setBusy(true)
      try {
        await uploadFile('/attachments/upload', f, { entity_type: entityType, entity_id: entityId, filename: f.name, kind })
        done(`Attached ${f.name}.`)
      } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
    }
    if (input.current) input.current.value = ''
  }
  const addLink = async () => {
    setBusy(true); setError(null)
    try {
      await api('/attachments/link', { method: 'POST', body: { entity_type: entityType, entity_id: entityId, url: link.url.trim(), title: link.title || null, kind } })
      setLink({ url: '', title: '' }); setMode(null); done('Link added.')
    } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
  }
  const remove = async (a: Attachment) => {
    if (!window.confirm(`Remove “${a.title}”?${a.url ? ' The file in Google Drive isn’t touched.' : ''}`)) return
    try { await api(`/attachments/${a.id}`, { method: 'DELETE' }); done(`Removed ${a.title}.`) } catch (e) { setError(e as ApiError) }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (canEdit) void send(e.dataTransfer.files) }

  return (
    <section className={`card attach-card${over ? ' over' : ''}`} aria-label="Files and links"
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(true) } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="card-head"><h2>Files &amp; links</h2>{d && <span className="muted small">{d.items.length}</span>}</div>
      <ErrorBanner error={error || list.error} onClose={() => setError(null)} />
      {d && d.items.length === 0 && <p className="muted small" style={{ margin: 0 }}>No proposals, contracts or other files yet.</p>}
      {d?.items.map((a) => (
        <div className="attach-row" key={a.id}>
          <span className={`attach-icon${a.url ? ' link' : ''}`} aria-hidden="true">{icon(a)}</span>
          <div className="attach-main">
            {a.url
              ? <a href={a.url} target="_blank" rel="noreferrer noopener" className="attach-title">{a.title}</a>
              : <button type="button" className="link-btn attach-title" onClick={() => downloadFile(`/attachments/${a.id}/download`, a.filename || a.title).catch((e: ApiError) => setError(e))}>{a.title}</button>}
            <span className="muted small"><span className="pill pill-paper">{a.kind}</span> {a.url ? 'Link' : size(a.size_bytes)} · {a.uploaded_by_name || 'someone'} · {fmtDate(a.created_at)}</span>
            {a.note && <span className="small">{a.note}</span>}
          </div>
          {(canEdit || can(user, 'edit_all') || a.uploaded_by === user.id) && (
            <button type="button" className="icon-btn" aria-label={`Remove ${a.title}`} onClick={() => void remove(a)}>×</button>
          )}
        </div>
      ))}
      {canEdit && d && <>
        <div className="attach-actions">
          <select className="input" aria-label="Type of file" value={kind} onChange={(e) => setKind(e.target.value)}>
            {d.kinds.map((k) => <option key={k}>{k}</option>)}
          </select>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Upload file'}</button>
          <button type="button" className="btn" aria-pressed={mode === 'link'} onClick={() => setMode(mode === 'link' ? null : 'link')}>Add link</button>
          <input ref={input} type="file" multiple hidden accept={d.extensions.map((e) => `.${e}`).join(',')} onChange={(e) => void send(e.target.files)} />
        </div>
        {mode === 'link' && (
          <form className="attach-link" onSubmit={(e) => { e.preventDefault(); void addLink() }}>
            <input className="input" type="url" required placeholder="https://docs.google.com/…" aria-label="Link" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
            <input className="input" placeholder="Title (optional)" aria-label="Link title" maxLength={200} value={link.title} onChange={(e) => setLink({ ...link, title: e.target.value })} />
            <button type="submit" className="btn btn-dark" disabled={busy || !link.url.trim()}>Add</button>
          </form>
        )}
        <span className="muted small">Drop files here or upload (PDF, Word, Excel, PowerPoint, images; up to 10 MB). Big files: link them from Google Drive.</span>
      </>}
    </section>
  )
}
