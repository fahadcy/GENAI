/**
 * Labels and tones the budget screens share. Pure, client-safe.
 */
import type { DiscrepancyKind, PacingStatus, Severity } from './types'

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'gold'

export const PLAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  in_review: { label: 'Awaiting approval', tone: 'warn' },
  changes_requested: { label: 'Changes requested', tone: 'danger' },
  approved: { label: 'Approved — not live', tone: 'brand' },
  active: { label: 'Live', tone: 'ok' },
  superseded: { label: 'Replaced', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'neutral' },
}

export const PACING_STATUS: Record<PacingStatus, { label: string; tone: Tone }> = {
  on_track: { label: 'On track', tone: 'ok' },
  under: { label: 'Under', tone: 'info' },
  over: { label: 'Over', tone: 'danger' },
  at_risk: { label: 'At risk', tone: 'warn' },
  no_data: { label: 'No data', tone: 'neutral' },
}

export const SEVERITY_TONE: Record<Severity, Tone> = { high: 'danger', medium: 'warn', low: 'neutral' }

export const DISC_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'danger' },
  explained: { label: 'Explained', tone: 'info' },
  resolved: { label: 'Resolved', tone: 'ok' },
}

export const QUALITY: Record<string, { label: string; tone: Tone; hint: string }> = {
  good: { label: 'Good evidence', tone: 'ok', hint: 'Six months or more of varied spend, and a curve that fits it.' },
  usable: { label: 'Usable', tone: 'info', hint: 'Enough history to steer by, with a wide band.' },
  thin: { label: 'Thin', tone: 'warn', hint: 'Mostly the prior: returns are assumed to flatten past about twice current spend.' },
  none: { label: 'No curve', tone: 'neutral', hint: 'No tracked outcomes.' },
}

export const BINDING_LABEL: Record<string, string> = {
  min: 'At minimum',
  max: 'At maximum',
  locked: 'Locked',
  evidence_cap: 'Evidence limit',
  shift_limit: 'Move limit',
  fixed: 'Fixed',
  none: '',
}

export const KIND_LABEL: Record<DiscrepancyKind, string> = {
  duplicate_charge: 'Duplicate charge',
  overcharge: 'Charged more than spend',
  unbilled_spend: 'Spend not billed',
  unbudgeted_spend: 'Unbudgeted spend',
  unknown_merchant: 'Unknown merchant',
  fx_cost: 'Currency conversion',
  refund_unmatched: 'Unmatched refund',
  stale_pending: 'Stale authorisation',
  line_overrun: 'Over plan',
  unverifiable: 'Cannot verify',
}
