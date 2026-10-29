const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SYM = { USD: '$', EUR: '€', GBP: '£' }

export function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${Number(day)} ${MON[Number(m) - 1]} ${y}`
}

export function fmtDateTime(d) {
  if (!d) return '—'
  const dt = new Date(d)
  return `${dt.getDate()} ${MON[dt.getMonth()]} ${dt.getFullYear()}, ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

export function money(v, cur = 'USD') {
  if (v === null || v === undefined || v === '') return '—'
  return (SYM[cur] || cur + ' ') + Math.round(Number(v)).toLocaleString('en-US')
}

// {USD: 1, GBP: 2} → "$1 · £2" (currencies are never added together)
export function moneyByCurrency(obj) {
  const parts = Object.entries(obj || {}).filter(([, v]) => Number(v)).map(([c, v]) => money(v, c))
  return parts.length ? parts.join(' · ') : '—'
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('')
}

export function nextActionLabel(lists, code, other) {
  if (!code) return ''
  if (code === lists?.other_code) return `Other: ${other || ''}`
  return lists?.next_actions?.find((n) => n.code === code)?.label || ''
}

export function userName(users, id) {
  return users.find((u) => u.id === id)?.name || '—'
}

export const probabilityOf = (lists, stage) => lists?.stages?.find((s) => s.name === stage)?.probability ?? 0
