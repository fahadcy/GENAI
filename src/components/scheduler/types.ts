/** Serialisable shapes crossing the server/client boundary on the Scheduler. */

export type ItemView = {
  id: string
  scheduledAt: string
  timezone: string
  channel: string
  status: string
  sendTimeSource: string
  predictedLift: number | null
  sendTimeRationale: string | null
  publishedAt: string | null
  externalRef: string | null
  attempts: number
  lastError: string | null
  nextRetryAt: string | null
  assetId: string
  assetTitle: string
  assetStatus: string
  compositeScore: number | null
  segmentId: string | null
  segmentName: string | null
  /** Reachable contacts on this item's channel, honouring consent. */
  reach: number | null
  campaignId: string | null
  campaignName: string | null
  createdByName: string | null
  createdByHue: number | null
}

export type BlackoutView = {
  id: string
  name: string
  startsAt: string
  endsAt: string
  /** Empty means every channel. */
  channels: string[]
  reason: string | null
}

export type CandidateView = {
  assetId: string
  title: string
  channel: string
  status: string
  version: number
  compositeScore: number | null
  campaignId: string | null
  campaignName: string | null
  updatedAt: string
  ready: boolean
  blockedReason: string | null
}

export type AttentionView = {
  id: string
  status: string
  channel: string
  scheduledAt: string
  attempts: number
  lastError: string | null
  nextRetryAt: string | null
  assetId: string
  assetTitle: string
  campaignName: string | null
}

export type SegmentOption = {
  id: string
  name: string
  reachableSize: number
  reachability: Record<string, number>
}

export type CapView = {
  id: string
  channel: string
  maxPerContact: number
  windowDays: number
  peakSegment: string | null
  peakCount: number
  segmentsAtCap: number
  totalPlaced: number
}

export type ConflictView = {
  kind: 'approval' | 'blackout' | 'frequency' | 'collision'
  message: string
  detail?: string
  suggestion?: string | Date
}

export type Capabilities = {
  create: boolean
  edit: boolean
  publish: boolean
}

/** What the pointer is currently carrying across the grid. */
export type DragPayload =
  | { kind: 'item'; id: string }
  | { kind: 'candidate'; assetId: string }
