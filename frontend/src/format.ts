import type { CurrencyTotals, Lists, Money, User } from './types'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SYM: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${Number(day)} ${MON[Number(m) - 1]} ${y}`
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return '—'
  const dt = new Date(d)
  return `${dt.getDate()} ${MON[dt.getMonth()]} ${dt.getFullYear()}, ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

export function money(v: Money | undefined, cur = 'USD'): string {
  if (v === null || v === undefined || v === '') return '—'
  return (SYM[cur] || `${cur} `) + Math.round(Number(v)).toLocaleString('en-US')
}

// {USD: 1, GBP: 2} → "$1 · £2" (currencies are never added together)
export function moneyByCurrency(obj: CurrencyTotals | null | undefined): string {
  const parts = Object.entries(obj || {}).filter(([, v]) => Number(v)).map(([c, v]) => money(v, c))
  return parts.length ? parts.join(' · ') : '—'
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10)

export function nextActionLabel(lists: Lists | null, code: string | null | undefined, other: string | null | undefined): string {
  if (!code) return ''
  if (code === lists?.other_code) return `Other: ${other || ''}`
  return lists?.next_actions.find((n) => n.code === code)?.label || ''
}

export function userName(users: User[], id: string | null | undefined): string {
  return users.find((u) => u.id === id)?.name || '—'
}

export const probabilityOf = (lists: Lists, stage: string): number => lists.stages.find((s) => s.name === stage)?.probability ?? 0

// Sum a numeric field per currency, e.g. open pipeline by currency.
export function totalsByCurrency<T extends { currency: string }>(rows: T[], value: (r: T) => Money): CurrencyTotals {
  const out: CurrencyTotals = {}
  for (const r of rows) out[r.currency] = (out[r.currency] || 0) + Number(value(r) || 0)
  return out
}
