import type { PlanStatus } from './schedule'

/**
 * The wire shapes between the planner's server components and its client
 * components. Everything is JSON-serialisable — dates are `YYYY-MM-DD` strings,
 * which is also the storage type, so nothing is reformatted in transit.
 */

export type LinkedAsset = {
  id: string
  title: string
  channel: string
  status: string
  compositeScore: number | null
}

export type TaskView = {
  id: string
  phase: string
  title: string
  description: string | null
  channel: string | null
  ownerId: string | null
  ownerName: string | null
  ownerHue: number | null
  ownerRole: string | null
  startDate: string | null
  dueDate: string | null
  dependsOn: string[]
  status: PlanStatus
  isMilestone: boolean
  /** The flag as last committed. The live projection is what the UI warns on. */
  atRisk: boolean
  sortIndex: number
  segmentId: string | null
  segmentName: string | null
  segmentReach: number | null
  approvalChainId: string | null
  approvalChainName: string | null
  approvalStepCount: number | null
  /** Approval requests raised for assets on this task, if any are outstanding. */
  approvalsPending: number
  assets: LinkedAsset[]
}

export type CampaignHeader = {
  id: string
  name: string
  objective: string
  status: string
  goalMetric: string
  targetValue: number | null
  budget: number
  startDate: string | null
  endDate: string | null
  channels: string[]
  ownerId: string | null
  ownerName: string | null
  ownerHue: number | null
  createdAt: string
}

export type CampaignSummary = CampaignHeader & {
  taskTotal: number
  taskDone: number
  taskBlocked: number
  atRisk: number
  milestoneDate: string | null
  spend: number
  goalActual: number
  phases: string[]
}

export type PickerOption = { id: string; name: string; detail: string | null }

export type TemplateView = {
  id: string
  name: string
  description: string | null
  taskCount: number
  phaseCount: number
  durationDays: number
  channels: string[]
  usageCount: number
  createdAt: string
}

/** A plan drafted by the agent but not yet written to the database (CP-1). */
export type DraftPlan = {
  draftId: string
  summary: string
  phases: string[]
  risks: string[]
  recommendedChannels: string[]
  simulated: boolean
  fromTemplate: string | null
  tasks: DraftTask[]
}

export type DraftTask = {
  ref: string
  phase: string
  title: string
  description: string | null
  channel: string | null
  ownerRole: string
  startOffsetDays: number
  durationDays: number
  dependsOn: string[]
  isMilestone: boolean
  needsApproval: boolean
  /** Resolved against the requested start date, so the review shows real dates. */
  startDate: string
  dueDate: string
  ownerName: string | null
  ownerHue: number | null
}

export const STATUS_ORDER: PlanStatus[] = ['not_started', 'in_progress', 'blocked', 'in_review', 'done']

export const STATUS_LABEL: Record<PlanStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  done: 'Done',
}

export const GOAL_METRIC_LABEL: Record<string, string> = {
  signups: 'Signups',
  conversions: 'Conversions',
  opens: 'Opens',
  clicks: 'Clicks',
  impressions: 'Impressions',
  revenue: 'Revenue',
  pipeline: 'Pipeline',
}

export const ROLE_TITLE: Record<string, string> = {
  owner: 'Owner',
  admin: 'Marketing ops',
  creator: 'Content creator',
  strategist: 'Growth marketer',
  approver: 'Reviewer / legal',
  analyst: 'Analyst',
}
