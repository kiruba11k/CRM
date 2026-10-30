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
  retired: Record<EditableList, string[]>
  reminders: ReminderSettings
}

export type EditableList = 'sources' | 'nurture_reasons' | 'lost_reasons' | 'service_lines' | 'account_statuses' | 'currencies'
export interface ReminderSettings { meeting_15: boolean; meeting_day: boolean; due_before: boolean; escalation: boolean; escalation_days: number }
export interface SettingsView {
  lists: Record<EditableList, { label: string; options: { value: string; active: boolean; in_use: number; protected: boolean }[] }>
  stages: { name: string; probability: number; editable: boolean; default: number }[]
  reminders: ReminderSettings
  reminder_defaults: ReminderSettings
}
export interface ChecklistItem { key: string; kind: 'decision' | 'test'; name: string; detail: string; done: boolean; note: string | null; updated_by: string | null; updated_at: string | null }
export interface SettingsChange { area: string; summary: string; changed_at: string; changed_by: string | null }

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
  next_action_time: string | null; next_action_time_zone: string | null; next_action_in_calendar: boolean
  account_name?: string | null; geography?: string | null; owner_name?: string | null; created_at?: string
}

export interface Opportunity {
  id: string; name: string; account_id: string; primary_contact_id: string | null; owner_id: string; stage: string
  estimated_value: Money; currency: string; expected_close: string | null; geography: string; service_line: string | null
  deal_source: string | null; risk_rating: string; high_risk_reason: string | null; risk_mitigation: string | null
  on_nurture: boolean; nurture_reason: string | null; nurture_until: string | null; nurture_owner_id: string | null
  nurture_next_action_code: string | null; nurture_next_action_other: string | null
  next_action_code: string | null; next_action_other: string | null; next_action_due: string | null
  next_action_time: string | null; next_action_time_zone: string | null; next_action_in_calendar: boolean
  proposal_due: string | null; delivery_lead: string | null; effort_estimate: string | null
  actual_value: Money; won_date: string | null; lost_date: string | null; lost_reason: string | null; lost_notes: string | null
  probability: number; weighted_value: Money; next_action_label: string
  account_name?: string; owner_name?: string | null; created_at?: string
}

export interface OpportunityDetail extends Opportunity {
  database_build_team: { id: string; name: string }[]
  proposal_team: { id: string; name: string }[]
  warnings: Issue[]; activities: Activity[]; history: HistoryEntry[]; follow_up: FollowUp | null
}

// The calendar event kept for a next action with a time (§6.1).
export interface FollowUp {
  id: string; title: string; starts_at: string; time_zone: string; sync_status: SyncState; sync_error: string | null
  html_link: string | null; google_event_id: string | null
}

export interface ProspectDetail extends Prospect {
  opportunities: Pick<Opportunity, 'id' | 'name' | 'stage' | 'estimated_value' | 'currency' | 'on_nurture'>[]
  activities: Activity[]; history: HistoryEntry[]; follow_up: FollowUp | null
}

export interface AccountDetail extends Account {
  prospects: Prospect[]; opportunities: Opportunity[]; activities: Activity[]; history: HistoryEntry[]
}

export type ActionKind = 'prospect' | 'opportunity' | 'nurture'
export interface ActionItem {
  kind: ActionKind; id: string; title: string; account_name: string | null; owner_id: string | null; owner_name: string | null
  code: string | null; other: string | null; due: string; nurture_reason: string | null; label: string
  days_until?: number | null; business_days_overdue?: number; escalated?: boolean; due_next_business_day?: boolean
  due_time: string | null; in_calendar: boolean
}
export interface ActionsResponse {
  as_of: string; scope: 'me' | 'team'
  counts: { overdue: number; today: number; upcoming: number; nurture: number; next_7_days: number; escalated: number; due_next_business_day: number }
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

// HubSpot import (backend/app/routers/hubspot_import.py)
export type ImportObject = 'owners' | 'companies' | 'contacts' | 'deals' | 'associations' | 'activity' | 'emails'
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'
export interface ImportPhase { done: number; total: number | null; state: 'waiting' | 'running' | 'done' }
export interface ImportRun {
  id: string; status: RunStatus; message: string | null; started_at: string; finished_at: string | null
  options: { objects?: ImportObject[]; stage_map?: Record<string, string> }
  progress: Partial<Record<'owners' | 'companies' | 'contacts' | 'deals' | 'activity', ImportPhase>>
  counts: Record<string, Record<'created' | 'updated' | 'kept' | 'merged' | 'failed', number>>
  error_count: number; errors?: { object: string; hubspot_id: string | null; message: string }[]
}
export interface ImportStatus { configured: boolean; last_run: ImportRun | null }
export interface HubSpotTest { portal_id: number | null; ui_domain: string | null; currency: string | null; time_zone: string | null; owners: number }
export interface HubSpotSummary {
  totals: Record<string, number | null>
  missing_scopes: string[]
  pipelines: { id: string; label: string | null; stages: { id: string; label: string | null; probability: string | null; closed: boolean }[] }[]
  suggested_stage_map: Record<string, string>
  lead_status_map: Record<string, string>
}
export interface QualityIssue { key: string; rule: string; fix: string; count: number; severity: 'amber' | 'red' }
export interface CleanupItem {
  entity: 'account' | 'prospect' | 'opportunity'; id: string; name: string; account_name: string | null
  owner_id: string | null; owner_name: string | null; reasons: string[]; hubspot_id: string | null
}

// Google Calendar sync (backend/app/routers/calendar.py)
export type SyncState = 'pending' | 'synced' | 'failed' | 'not_connected' | 'cancelled'
export interface Meeting {
  id: string; entity_type: 'account' | 'prospect' | 'opportunity' | null; entity_id: string | null; entity_name: string | null
  owner_id: string; owner_name: string; title: string; description: string | null; starts_at: string; ends_at: string; time_zone: string
  attendees: string[]; add_meet: boolean; reminder_15: boolean; reminder_day: boolean
  google_event_id: string | null; html_link: string | null; meet_url: string | null
  sync_status: SyncState; sync_error: string | null; synced_at: string | null; cancelled: boolean
  kind: 'meeting' | 'follow_up'; calendar_id: string | null
}
export interface CalendarStatus {
  configured: boolean; missing: string[]; connected: boolean
  connection: { google_email: string; status: 'connected' | 'needs_reconnect'; connected_at: string; last_sync_at: string | null; last_error: string | null } | null
}
export interface CalendarSyncStatus {
  users: { id: string; name: string; email: string; status: 'connected' | 'needs_reconnect' | null; google_email: string | null
    last_sync_at: string | null; last_error: string | null; unsynced: number; booking_links: number }[]
  log: { at: string; action: string; ok: boolean; message: string; meeting_id: string | null; user_name: string | null; meeting_title: string | null }[]
}
export interface BookingLink { id: string; owner_id: string; owner_name: string; name: string; url: string; active: boolean; created_at: string }
