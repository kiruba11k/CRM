// Settings → Slack: post deal wins/losses, new deals, stage moves and a daily
// team summary to Slack channels through incoming webhooks.
import { useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDateTime } from '../format'
import { can, useSession } from '../session'
import { Banner, ErrorBanner, useLoad } from '../ui'
import { useToast } from './Toast'

interface Channel { id: string; name: string; webhook_hint: string; events: string[]; active: boolean; last_ok_at: string | null; last_error: string | null }
interface SlackView {
  events: { key: string; label: string; default: boolean }[]; ready: boolean; channels: Channel[]
  log: { at: string; event: string; ok: boolean; message: string; channel: string | null }[]
}

export default function SlackSettings() {
  const { user } = useSession()
  const admin = can(user, 'manage_settings')
  const toast = useToast()
  const data = useLoad(() => api<SlackView>('/slack'), [])
  const [view, setView] = useState<SlackView | null>(null)
  const v = view || data.data
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', webhook_url: '' })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const run = async <T,>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    setBusy(key); setError(null)
    try { const r = await fn(); if (ok) toast(ok); return r } catch (e) { setError(e as ApiError); return null } finally { setBusy('') }
  }
  // Show the change at once; the server's answer (or the old state) replaces it.
  const patch = (c: Channel, body: Partial<Channel>, ok?: string) => {
    const before = v
    if (v) setView({ ...v, channels: v.channels.map((x) => (x.id === c.id ? { ...x, ...body } : x)) })
    void run(c.id, () => api<SlackView>(`/slack/${c.id}`, { method: 'PATCH', body }), ok).then((r) => setView(r || before))
  }
  const label = (k: string) => v?.events.find((e) => e.key === k)?.label || k

  return (
    <>
      <section className="card" aria-label="Slack">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div><h2>Slack notifications</h2><span className="muted small">Wins, losses, new deals, stage moves and a daily team summary, posted to your channels.</span></div>
          {admin && !adding && <button type="button" className="btn btn-dark" onClick={() => setAdding(true)}>+ Add channel</button>}
        </div>
        <ErrorBanner error={error || data.error} onClose={() => setError(null)} />
        {v && !v.ready && <Banner kind="warn">CRM_TOKEN_KEY isn’t set on the API server, so webhooks can’t be stored safely yet.</Banner>}
        {!admin && <Banner kind="warn">Only people who can manage CRM settings can change Slack notifications.</Banner>}

        {adding && v && (
          <form className="person-form" onSubmit={(e) => {
            e.preventDefault()
            void run('add', () => api<SlackView>('/slack', { method: 'POST', body: form }), `Channel ${form.name} added. Send a test to check it.`)
              .then((r) => { if (r) { setView(r); setAdding(false); setForm({ name: '', webhook_url: '' }) } })
          }}>
            <ol className="small slack-steps">
              <li>In Slack, open <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From scratch</strong>, name it “LeadStrategus CRM”, pick your workspace.</li>
              <li>Open <strong>Incoming Webhooks</strong>, switch it on, click <strong>Add New Webhook to Workspace</strong> and choose the channel.</li>
              <li>Copy the webhook URL (it starts with https://hooks.slack.com/services/) and paste it below.</li>
            </ol>
            <div className="grid-fields">
              <label className="field"><span className="label">Channel name <span className="req">*</span></span>
                <input className="input" required maxLength={80} placeholder="#sales-wins" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field"><span className="label">Webhook URL <span className="req">*</span></span>
                <input className="input" required type="url" autoComplete="off" placeholder="https://hooks.slack.com/services/…" value={form.webhook_url} onChange={(e) => setForm({ ...form, webhook_url: e.target.value })} /></label>
            </div>
            <span className="muted small">Starts with: {v.events.filter((e) => e.default).map((e) => e.label.split(' (')[0]).join(', ')}. You can change this after. The URL is stored encrypted and never shown again.</span>
            <div className="row" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-dark" disabled={busy === 'add' || !form.name.trim() || !form.webhook_url.trim()}>{busy === 'add' ? 'Adding…' : 'Add channel'}</button>
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        )}

        {v && v.channels.length === 0 && !adding && <div className="empty">No Slack channels yet.</div>}
        {v?.channels.map((c) => (
          <div key={c.id} className={`slack-channel${c.active ? '' : ' off'}`}>
            <div className="slack-head">
              <span className="slack-name">{c.name}</span>
              <span className="muted small">webhook {c.webhook_hint}</span>
              {c.last_error
                ? <span className="pill pill-red" title={c.last_error}>Last post failed</span>
                : c.last_ok_at ? <span className="pill pill-teal">Last post {fmtDateTime(c.last_ok_at)}</span> : <span className="pill pill-paper">Not used yet</span>}
              <span className="sv-spacer" />
              {admin && <>
                <button type="button" className="btn" disabled={busy === c.id} onClick={() => void run(c.id, () => api(`/slack/${c.id}/test`, { method: 'POST' }), `Test sent to ${c.name}.`).then(() => data.reload().then(() => setView(null)))}>Send test</button>
                <label className="check"><input type="checkbox" checked={c.active} onChange={(e) => patch(c, { active: e.target.checked }, e.target.checked ? `${c.name} on.` : `${c.name} paused.`)} /> {c.active ? 'On' : 'Paused'}</label>
                <button type="button" className="icon-btn" aria-label={`Remove ${c.name}`} onClick={() => {
                  if (window.confirm(`Remove ${c.name}? The CRM stops posting there (the Slack app itself stays installed).`))
                    void run(c.id, () => api<SlackView>(`/slack/${c.id}`, { method: 'DELETE' }), `${c.name} removed.`).then((r) => r && setView(r))
                }}>×</button>
              </>}
            </div>
            {c.last_error && <span className="small" style={{ color: 'var(--red-ink)' }}>{c.last_error}</span>}
            <div className="slack-events">
              {v.events.map((e) => (
                <label key={e.key} className="check small">
                  <input type="checkbox" disabled={!admin} checked={c.events.includes(e.key)}
                    onChange={(ev) => patch(c, { events: ev.target.checked ? [...c.events, e.key] : c.events.filter((x) => x !== e.key) })} /> {e.label}
                </label>
              ))}
            </div>
          </div>
        ))}
        {admin && v?.channels.some((c) => c.events.includes('daily_summary')) && (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-outline" disabled={busy === 'sum'}
              onClick={() => void run('sum', () => api<{ sent: number }>('/slack/summary-now', { method: 'POST' })).then((r) => { if (r) toast(`Summary posted to ${r.sent} channel${r.sent === 1 ? '' : 's'}.`) })}>Post today’s summary now</button>
            <span className="muted small">Otherwise it goes out once a day with the digest (Reminders tab sets the time).</span>
          </div>
        )}
      </section>

      {v && v.log.length > 0 && (
        <section className="card" aria-label="Slack delivery log">
          <h2>Recent posts</h2>
          {v.log.map((l, i) => (
            <div className="list-row" key={i}>
              <span style={{ flex: '1 1 320px', minWidth: 0 }}>
                <span className={`pill pill-${l.ok ? 'teal' : 'red'}`}>{l.ok ? 'Sent' : 'Failed'}</span> <strong>{l.channel || 'removed channel'}</strong>
                <span className="muted small"> · {label(l.event)} · {fmtDateTime(l.at)}</span><br />
                <span className="small slack-msg">{l.message}</span>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  )
}
