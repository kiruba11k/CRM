import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api, downloadCsv } from '../api'
import { useSession } from '../session'
import type { Account } from '../types'
import { ErrorBanner, SelectField, Tabs, TextField, useLoad } from '../ui'

const STATUS_PILL: Record<string, string> = { Target: 'blue', 'Active customer': 'teal', 'Inactive / do not pursue': 'paper' }

export default function Accounts() {
  const { lists } = useSession()
  const [status, setStatus] = useState('all')
  const [country, setCountry] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [exportError, setExportError] = useState<ApiError | null>(null)
  const { data, error, loading } = useLoad(() => api<Account[]>('/accounts'), [])
  const rows = useMemo(() => data || [], [data])
  const filtered = useMemo(() => rows.filter((a) => (status === 'all' || a.status === status) && (!country || a.country === country)
    && (!q || `${a.name} ${a.industry || ''}`.toLowerCase().includes(q.toLowerCase()))), [rows, status, country, q])
  const countries = [...new Set(rows.map((a) => a.country))].sort()

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p>One record per company. Each account can have many prospects and many opportunities.</p>
        </div>
        <button type="button" className="btn" onClick={() => downloadCsv('accounts').catch((e: ApiError) => setExportError(e))}>Export CSV</button>
      </div>
      <ErrorBanner error={exportError} onClose={() => setExportError(null)} />
      <Tabs label="Account status" value={status} onChange={setStatus}
        tabs={[{ value: 'all', label: 'All accounts', count: rows.length }, ...lists.account_statuses.map((s) => ({ value: s, label: s, count: rows.filter((a) => a.status === s).length }))]} />
      <div className="row-end">
        <div style={{ width: 260 }}><TextField label="Search" value={q} onChange={setQ} placeholder="Name or industry" /></div>
        <div style={{ width: 200 }}><SelectField label="Geography" value={country} onChange={setCountry} options={countries} placeholder="All countries" /></div>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <div className="loading">Loading accounts…</div> : (
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <thead><tr><th>Account</th><th>Status</th><th>Geography</th><th>Owner</th><th className="num">Prospects</th><th className="num">Open opportunities</th><th className="num">Won</th></tr></thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/accounts/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link><div className="sub">{a.industry}</div></td>
                  <td><span className={`pill pill-${STATUS_PILL[a.status] || 'grey'}`}>{a.status}</span></td>
                  <td className="muted">{a.country}{a.region ? ` · ${a.region}` : ''}</td>
                  <td className="muted">{a.owner_name || '—'}</td>
                  <td className="num">{a.prospect_count}</td>
                  <td className="num">{a.open_count}</td>
                  <td className="num">{a.won_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty">No accounts match. Use “+ Account” to add one.</div>}
        </div>
      )}
    </>
  )
}
