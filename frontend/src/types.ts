// Shapes returned by the CRM API (backend/app). Dates are ISO strings
// ("2026-10-29"); money fields arrive as numbers or numeric strings.

export type Role = 'salesperson' | 'manager' | 'admin'
export type Money = number | string | null

export interface User { id: string; email: string; name: string; role: Role; active?: boolean }

export interface Lists {
  next_actions: { code: string; label: string }[]
  other_code: string
  other_max_length: number
  stages: { name: string; probability: number }[]
  prospect_statuses: string[]
  risk_ratings: string[]
  account_statuses: string[]
  sources: string[]
  nurture_reasons: string[]
  lost_reasons: string[]
  service_lines: string[]
  currencies: string[]
  roles: Role[]
}

export interface Issue { field: string; message: string }

export interface Activity { id: string; kind: string; summary: string; occurred_at: string; created_by: string | null }
export interface HistoryEntry { field: string; old_value: string | null; new_value: string | null; changed_at: string; changed_by: string | null }

export interface Account {
  id: string; name: string; country: string; region: string | null; industry: string | null; owner_id: string | null
  status: string; website: string | null; linkedin_url: string | null; notes: string | null
  owner_name?: string | null; prospect_count?: number; open_count?: number; won_count?: number
}

export interface Prospect {
  id: string; full_name: string; account_id: string | null; job_title: string | null; email: string | null; phone: string | null
  linkedin_url: string | null; owner_id: string | null; status: string; disqualified_reason: string | null; source: string | null
  next_action_code: string | null; next_action_other: string | null; next_action_due: string | null; notes: string | null
  account_name?: string | null; geography?: string | null; owner_name?: string | null
}

export interface Opportunity {
  id: string; name: string; account_id: string; primary_contact_id: string | null; owner_id: string; stage: string
  estimated_value: Money; currency: string; expected_close: string | null; geography: string; service_line: string | null
  deal_source: string | null; risk_rating: string; high_risk_reason: string | null; risk_mitigation: string | null
  on_nurture: boolean; nurture_reason: string | null; nurture_until: string | null; nurture_owner_id: string | null
  nurture_next_action_code: string | null; nurture_next_action_other: string | null
  next_action_code: string | null; next_action_other: string | null; next_action_due: string | null
  proposal_due: string | null; delivery_lead: string | null; effort_estimate: string | null
  actual_value: Money; won_date: string | null; lost_date: string | null; lost_reason: string | null; lost_notes: string | null
  probability: number; weighted_value: Money; next_action_label: string
  account_name?: string; owner_name?: string | null
}

export interface OpportunityDetail extends Opportunity {
  database_build_team: { id: string; name: string }[]
  proposal_team: { id: string; name: string }[]
  warnings: Issue[]; activities: Activity[]; history: HistoryEntry[]
}

export interface ProspectDetail extends Prospect {
  opportunities: Pick<Opportunity, 'id' | 'name' | 'stage' | 'estimated_value' | 'currency' | 'on_nurture'>[]
  activities: Activity[]; history: HistoryEntry[]
}

export interface AccountDetail extends Account {
  prospects: Prospect[]; opportunities: Opportunity[]; activities: Activity[]; history: HistoryEntry[]
}

export type ActionKind = 'prospect' | 'opportunity' | 'nurture'
export interface ActionItem {
  kind: ActionKind; id: string; title: string; account_name: string | null; owner_id: string | null; owner_name: string | null
  code: string | null; other: string | null; due: string; nurture_reason: string | null; label: string
  days_until?: number | null; business_days_overdue?: number; escalated?: boolean
}
export interface ActionsResponse {
  as_of: string; scope: 'me' | 'team'
  counts: { overdue: number; today: number; upcoming: number; nurture: number; next_7_days: number; escalated: number }
  overdue: ActionItem[]; today: ActionItem[]; upcoming: ActionItem[]; nurture: ActionItem[]
}

export type CurrencyTotals = Record<string, number>
export interface PipelineReport {
  stages: { stage: string; probability: number; count: number; unweighted: CurrencyTotals; weighted: CurrencyTotals }[]
  active_forecast: { count: number; unweighted: CurrencyTotals; weighted: CurrencyTotals }
  nurture: { count: number; value: CurrencyTotals }
}
export interface ForecastPeriod { period: string; count: number; unweighted: CurrencyTotals; weighted: CurrencyTotals }

// Editable form state: field name → value as the inputs hold it.
export type FormValue = string | number | boolean | null | undefined | string[]
export type FormValues = Record<string, FormValue>
export type FieldErrors = Record<string, string>
