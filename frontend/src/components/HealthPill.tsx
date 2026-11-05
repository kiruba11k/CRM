// Deal health: High / Medium / Low with every reason in the tooltip.
import type { StaleDeal } from '../types'

const TONE = { High: 'red', Medium: 'amber', Low: 'blue' } as const

export default function HealthPill({ deal, full = false }: { deal?: StaleDeal; full?: boolean }) {
  if (!deal?.level) return full ? <span className="pill pill-teal">Healthy</span> : <span className="muted small">—</span>
  const why = deal.reasons.map((r) => r.label).join(' · ')
  return (
    <span className="health" title={why}>
      <span className={`pill pill-${TONE[deal.level]}`}>{deal.level} risk</span>
      {full && <span className="small muted health-why">{why}</span>}
    </span>
  )
}
