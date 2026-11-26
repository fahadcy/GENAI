/**
 * Aurea — data model.
 *
 * Design notes
 * ------------
 * 1. Every business table carries `workspaceId`. Tenant isolation is enforced in
 *    the data-access layer (src/lib/db/tenant.ts), never left to a caller.
 * 2. The approval + audit tables are append-only. `auditEvents` is hash-chained
 *    so a tampered row breaks verification (PRD AP-3: "cannot be edited after the fact").
 * 3. Contacts are real rows, so segment rules are genuinely evaluated rather than
 *    estimated — that's what makes AT-1/AT-5 provable.
 */
import { relations, sql } from 'drizzle-orm'
import type {
  BusinessProfile as SerpTwinBusinessProfile,
  Lead as SerpTwinLead,
  Recommendation as SerpTwinRecommendation,
  SerpTwinReport,
} from '../serptwin'
import type {
  ClassifiedCandidate as CompetitorCandidate,
  Change as CompetitorChange,
  CompanyProfile as CompetitorCompanyProfile,
  CompetitorAnalysis,
  LandscapeReport as CompetitorLandscapeReport,
  PresenceSnapshot as CompetitorSnapshot,
} from '../competitors/types'
import type {
  AllocationResult as BudgetAllocationResult,
  AllocationSettings as BudgetAllocationSettings,
  ReconciliationReport as BudgetReconciliationReport,
  StoredCurve as BudgetStoredCurve,
} from '../budget/types'
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/* ------------------------------------------------------------------ enums */

export const roleEnum = pgEnum('role', [
  'owner', // marketing manager / owner
  'admin', // marketing ops / admin
  'creator', // content creator
  'strategist', // campaign / growth marketer
  'approver', // reviewer / approver incl. legal
  'analyst', // read-only + reporting
])

export const planEnum = pgEnum('plan', ['trial', 'studio', 'growth', 'scale', 'enterprise'])

export const assetStatusEnum = pgEnum('asset_status', [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'scheduled',
  'published',
  'archived',
])

export const channelEnum = pgEnum('channel', [
  'email',
  'linkedin',
  'x',
  'instagram',
  'facebook',
  'blog',
  'google_ads',
  'meta_ads',
  'sms',
  'push',
  'web',
])

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'planning',
  'active',
  'paused',
  'completed',
  'archived',
])

export const planItemStatusEnum = pgEnum('plan_item_status', [
  'not_started',
  'in_progress',
  'blocked',
  'in_review',
  'done',
])

export const scheduleStatusEnum = pgEnum('schedule_status', [
  'scheduled',
  'publishing',
  'published',
  'failed',
  'dead_letter',
  'cancelled',
])

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
])

export const decisionEnum = pgEnum('decision', ['approve', 'reject', 'delegate', 'comment'])

export const recStatusEnum = pgEnum('rec_status', ['open', 'applied', 'dismissed', 'reverted', 'expired'])

export const connectorStatusEnum = pgEnum('connector_status', [
  'disconnected',
  'connected',
  'degraded',
  'error',
])

export const pipelineStageEnum = pgEnum('pipeline_stage', [
  'generate',
  'review',
  'approve',
  'publish',
  'monitor',
])

/* ------------------------------------------------------- tenancy & people */

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    plan: planEnum('plan').notNull().default('trial'),
    seats: integer('seats').notNull().default(3),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    /** PRD 7: configurable data residency. */
    dataResidency: varchar('data_residency', { length: 8 }).notNull().default('eu'),
    settings: jsonb('settings')
      .$type<{
        defaultTimezone: string
        weekStartsOn: number
        currency: string
        requireApprovalAboveSpend?: number
        aiProvider?: string
        aiModelOverride?: string | null
      }>()
      .notNull()
      .default({ defaultTimezone: 'Europe/London', weekStartsOn: 1, currency: 'GBP' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspaces_slug_idx').on(t.slug)],
)

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    /** Populated when the account arrives via SAML/OIDC rather than a password. */
    ssoSubject: text('sso_subject'),
    avatarHue: integer('avatar_hue').notNull().default(250),
    jobTitle: text('job_title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_idx').on(sql`lower(${t.email})`)],
)

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('creator'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_ws_user_idx').on(t.workspaceId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: varchar('ip', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_token_idx').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
)

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: roleEnum('role').notNull().default('creator'),
    token: text('token').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invitations_ws_idx').on(t.workspaceId), uniqueIndex('invitations_token_idx').on(t.token)],
)

/* ------------------------------------------------------ brand governance */

export type ToneAxis = {
  /** 0..100 on each axis; the guardrail scores distance from target. */
  formal: number
  playful: number
  technical: number
  urgent: number
  warm: number
}

export const brandProfiles = pgTable(
  'brand_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    /** Free-text voice description fed to the model. */
    voice: text('voice').notNull().default(''),
    tone: jsonb('tone').$type<ToneAxis>().notNull().default({
      formal: 55,
      playful: 35,
      technical: 45,
      urgent: 30,
      warm: 60,
    }),
    doList: jsonb('do_list').$type<string[]>().notNull().default([]),
    dontList: jsonb('dont_list').$type<string[]>().notNull().default([]),
    bannedTerms: jsonb('banned_terms').$type<string[]>().notNull().default([]),
    preferredTerms: jsonb('preferred_terms').$type<{ avoid: string; use: string }[]>().notNull().default([]),
    requiredDisclaimers: jsonb('required_disclaimers')
      .$type<{ text: string; channels: string[] }[]>()
      .notNull()
      .default([]),
    readingLevelMax: integer('reading_level_max').notNull().default(11),
    maxExclamations: integer('max_exclamations').notNull().default(1),
    colors: jsonb('colors').$type<{ primary: string; secondary: string; accent: string }>().notNull().default({
      primary: '#5B4BE0',
      secondary: '#0E1116',
      accent: '#E8B341',
    }),
    logoUrl: text('logo_url'),
    /** Minimum composite score an asset must reach before a human sees it. */
    passThreshold: integer('pass_threshold').notNull().default(80),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('brand_ws_idx').on(t.workspaceId)],
)

export const legalRules = pgTable(
  'legal_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Case-insensitive JS regex source. */
    pattern: text('pattern').notNull(),
    severity: varchar('severity', { length: 16 }).notNull().default('high'), // high | medium | low
    message: text('message').notNull(),
    remedy: text('remedy'),
    channels: jsonb('channels').$type<string[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('legal_ws_idx').on(t.workspaceId)],
)

/* ------------------------------------------------------------- campaigns */

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    objective: text('objective').notNull(),
    goalMetric: varchar('goal_metric', { length: 32 }).notNull().default('signups'),
    targetValue: integer('target_value'),
    budget: numeric('budget', { precision: 12, scale: 2 }).notNull().default('0'),
    status: campaignStatusEnum('status').notNull().default('draft'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    ownerId: uuid('owner_id').references(() => users.id),
    channels: jsonb('channels').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_ws_idx').on(t.workspaceId, t.status)],
)

export const planItems = pgTable(
  'plan_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    phase: text('phase').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    channel: channelEnum('channel'),
    ownerId: uuid('owner_id').references(() => users.id),
    startDate: date('start_date'),
    dueDate: date('due_date'),
    /** Ids of plan items that must finish first (CP-4 slippage recalculation). */
    dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
    status: planItemStatusEnum('status').notNull().default('not_started'),
    segmentId: uuid('segment_id'),
    approvalChainId: uuid('approval_chain_id'),
    isMilestone: boolean('is_milestone').notNull().default(false),
    atRisk: boolean('at_risk').notNull().default(false),
    sortIndex: integer('sort_index').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('plan_items_campaign_idx').on(t.campaignId, t.sortIndex)],
)

export const campaignTemplates = pgTable('campaign_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  payload: jsonb('payload').notNull(),
  usageCount: integer('usage_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/* ---------------------------------------------------------- content work */

export const briefs = pgTable(
  'briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    planItemId: uuid('plan_item_id').references(() => planItems.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    audienceNote: text('audience_note'),
    keyMessages: jsonb('key_messages').$type<string[]>().notNull().default([]),
    channels: jsonb('channels').$type<string[]>().notNull().default([]),
    callToAction: text('call_to_action'),
    mustInclude: jsonb('must_include').$type<string[]>().notNull().default([]),
    mustAvoid: jsonb('must_avoid').$type<string[]>().notNull().default([]),
    brandProfileId: uuid('brand_profile_id').references(() => brandProfiles.id),
    variantsPerChannel: integer('variants_per_channel').notNull().default(2),
    /**
     * The competitive context the generator was given, when the brief asked
     * for it. Kept with the brief so a reviewer can see what steered the copy,
     * and so a regenerate uses the same context rather than a newer one.
     */
    competitorContext: jsonb('competitor_context').$type<CompetitorContextRef>(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('briefs_ws_idx').on(t.workspaceId)],
)

export type AssetBody = {
  subject?: string
  preheader?: string
  headline?: string
  body: string
  cta?: string
  hashtags?: string[]
  altText?: string
}

export type ScoreDetail = {
  brand: { score: number; axes: Record<string, number>; notes: string[] }
  compliance: { score: number; findings: GuardrailFinding[] }
  readability: { score: number; grade: number }
  composite: number
  passed: boolean
  evaluatedAt: string
}

export type GuardrailFinding = {
  ruleId: string
  ruleName: string
  severity: 'high' | 'medium' | 'low'
  message: string
  remedy?: string
  excerpt?: string
  offset?: number
}

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    briefId: uuid('brief_id').references(() => briefs.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    planItemId: uuid('plan_item_id').references(() => planItems.id, { onDelete: 'set null' }),
    channel: channelEnum('channel').notNull(),
    variantLabel: varchar('variant_label', { length: 8 }).notNull().default('A'),
    title: text('title').notNull(),
    body: jsonb('body').$type<AssetBody>().notNull(),
    imageUrl: text('image_url'),
    imagePrompt: text('image_prompt'),
    status: assetStatusEnum('status').notNull().default('draft'),
    stage: pipelineStageEnum('stage').notNull().default('generate'),
    brandScore: integer('brand_score'),
    complianceScore: integer('compliance_score'),
    compositeScore: integer('composite_score'),
    scoreDetail: jsonb('score_detail').$type<ScoreDetail>(),
    version: integer('version').notNull().default(1),
    /** Set when this asset was generated to replace a fatiguing one (PF-3 loop). */
    replacesAssetId: uuid('replaces_asset_id'),
    aiGenerated: boolean('ai_generated').notNull().default(true),
    editedByHuman: boolean('edited_by_human').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assets_ws_status_idx').on(t.workspaceId, t.status),
    index('assets_campaign_idx').on(t.campaignId),
    index('assets_brief_idx').on(t.briefId),
  ],
)

export const assetVersions = pgTable(
  'asset_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: jsonb('body').$type<AssetBody>().notNull(),
    scoreDetail: jsonb('score_detail').$type<ScoreDetail>(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('asset_versions_idx').on(t.assetId, t.version)],
)

/* ------------------------------------------------------------- targeting */

export type SegmentRule = {
  field: string
  op: 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'within_days' | 'exists'
  value: unknown
  label?: string
}

export type SegmentRuleGroup = {
  combinator: 'and' | 'or'
  rules: (SegmentRule | SegmentRuleGroup)[]
}

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    email: varchar('email', { length: 320 }).notNull(),
    /**
     * Stored as entered, normalised to E.164 at send time rather than on write
     * — a number typed as "07700 900123" is what the person recognises when
     * they look at their own list, and rewriting it in the database makes an
     * import look like it corrupted their data.
     */
    phone: varchar('phone', { length: 32 }),
    name: text('name'),
    company: text('company'),
    jobTitle: text('job_title'),
    country: varchar('country', { length: 2 }),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/London'),
    industry: text('industry'),
    employees: integer('employees'),
    lifecycleStage: varchar('lifecycle_stage', { length: 32 }).notNull().default('lead'),
    plan: varchar('plan', { length: 32 }),
    mrr: numeric('mrr', { precision: 10, scale: 2 }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    signupAt: timestamp('signup_at', { withTimezone: true }),
    /** AT-5: consent + suppression are enforced by the engine, not by the caller. */
    consent: jsonb('consent')
      .$type<{ email: boolean; sms: boolean; push: boolean; ads: boolean; capturedAt: string; basis: string }>()
      .notNull()
      .default({ email: false, sms: false, push: false, ads: false, capturedAt: '', basis: 'unknown' }),
    suppressed: boolean('suppressed').notNull().default(false),
    suppressionReason: text('suppression_reason'),
    /** Hour-of-day 0-23 the contact historically engages — feeds SC-2. */
    engagementHour: integer('engagement_hour'),
    engagementScore: real('engagement_score').notNull().default(0),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contacts_ws_idx').on(t.workspaceId),
    uniqueIndex('contacts_ws_email_idx').on(t.workspaceId, sql`lower(${t.email})`),
    index('contacts_lifecycle_idx').on(t.workspaceId, t.lifecycleStage),
  ],
)

export const segments = pgTable(
  'segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** The sentence the marketer actually typed (AT-1). */
    nlQuery: text('nl_query'),
    rules: jsonb('rules').$type<SegmentRuleGroup>().notNull().default({ combinator: 'and', rules: [] }),
    sourceType: varchar('source_type', { length: 16 }).notNull().default('rule'), // rule | lookalike | import
    seedSegmentId: uuid('seed_segment_id'),
    similarityThreshold: real('similarity_threshold').notNull().default(0.75),
    estimatedSize: integer('estimated_size').notNull().default(0),
    reachableSize: integer('reachable_size').notNull().default(0),
    suppressedCount: integer('suppressed_count').notNull().default(0),
    predictedConversion: real('predicted_conversion'),
    reachability: jsonb('reachability').$type<Record<string, number>>().notNull().default({}),
    syncTargets: jsonb('sync_targets').$type<string[]>().notNull().default([]),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('segments_ws_idx').on(t.workspaceId)],
)

export const segmentMembers = pgTable(
  'segment_members',
  {
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => segments.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    score: real('score').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.contactId] })],
)

/* ------------------------------------------------------------ scheduling */

export const scheduleItems = pgTable(
  'schedule_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id').references(() => segments.id, { onDelete: 'set null' }),
    channel: channelEnum('channel').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/London'),
    status: scheduleStatusEnum('status').notNull().default('scheduled'),
    /** ai | manual — SC-2 requires the override to be visible. */
    sendTimeSource: varchar('send_time_source', { length: 8 }).notNull().default('manual'),
    predictedLift: real('predicted_lift'),
    sendTimeRationale: text('send_time_rationale'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    externalRef: text('external_ref'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('schedule_ws_time_idx').on(t.workspaceId, t.scheduledAt),
    index('schedule_status_idx').on(t.status, t.nextRetryAt),
  ],
)

export const blackoutWindows = pgTable('blackout_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  channels: jsonb('channels').$type<string[]>().notNull().default([]),
  reason: text('reason'),
})

export const frequencyCaps = pgTable('frequency_caps', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  channel: channelEnum('channel').notNull(),
  maxPerContact: integer('max_per_contact').notNull().default(3),
  windowDays: integer('window_days').notNull().default(7),
})

/* --------------------------------------------------- approvals and audit */

export type ApprovalStep = {
  name: string
  /** Any member holding this role may act, unless approverIds narrows it. */
  role: string
  approverIds?: string[]
  mode: 'any' | 'all'
  slaHours: number
}

export type ChainScope = {
  channels?: string[]
  assetStatuses?: string[]
  spendThreshold?: number
  campaignIds?: string[]
  subjectTypes?: string[]
}

export const approvalChains = pgTable(
  'approval_chains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    scope: jsonb('scope').$type<ChainScope>().notNull().default({}),
    steps: jsonb('steps').$type<ApprovalStep[]>().notNull().default([]),
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    /** Higher wins when several chains match. */
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chains_ws_idx').on(t.workspaceId, t.active)],
)

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subjectType: varchar('subject_type', { length: 32 }).notNull().default('asset'),
    subjectId: uuid('subject_id').notNull(),
    chainId: uuid('chain_id')
      .notNull()
      .references(() => approvalChains.id),
    currentStep: integer('current_step').notNull().default(0),
    status: approvalStatusEnum('status').notNull().default('pending'),
    /** Snapshot of the version under review, so a later edit forces re-review. */
    subjectVersion: integer('subject_version').notNull().default(1),
    requestedBy: uuid('requested_by').references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Milliseconds from request to final decision — powers the CC-2 KPI. */
    resolutionMs: integer('resolution_ms'),
  },
  (t) => [
    index('approvals_ws_status_idx').on(t.workspaceId, t.status),
    index('approvals_subject_idx').on(t.subjectType, t.subjectId),
  ],
)

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    step: integer('step').notNull(),
    userId: uuid('user_id').references(() => users.id),
    decision: decisionEnum('decision').notNull(),
    comment: text('comment'),
    delegatedToId: uuid('delegated_to_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('decisions_request_idx').on(t.requestId)],
)

/**
 * Append-only, hash-chained. `hash = sha256(prevHash || canonical(payload))`.
 * See src/lib/workflow/audit.ts — verifyChain() walks the whole workspace.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id),
    actorType: varchar('actor_type', { length: 16 }).notNull().default('user'), // user | system | copilot
    action: varchar('action', { length: 64 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: uuid('subject_id'),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: varchar('prev_hash', { length: 64 }),
    hash: varchar('hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_ws_seq_idx').on(t.workspaceId, t.seq),
    index('audit_subject_idx').on(t.subjectType, t.subjectId),
  ],
)

/* ---------------------------------------------------------- performance */

export const metricFacts = pgTable(
  'metric_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id').references(() => segments.id, { onDelete: 'set null' }),
    channel: channelEnum('channel').notNull(),
    impressions: integer('impressions').notNull().default(0),
    opens: integer('opens').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    conversions: integer('conversions').notNull().default(0),
    signups: integer('signups').notNull().default(0),
    pipeline: numeric('pipeline', { precision: 12, scale: 2 }).notNull().default('0'),
    revenue: numeric('revenue', { precision: 12, scale: 2 }).notNull().default('0'),
    spend: numeric('spend', { precision: 12, scale: 2 }).notNull().default('0'),
  },
  (t) => [
    index('metrics_ws_day_idx').on(t.workspaceId, t.day),
    index('metrics_asset_idx').on(t.assetId, t.day),
    index('metrics_campaign_idx').on(t.campaignId, t.day),
  ],
)

export type RecommendationAction =
  | { kind: 'pause_asset'; assetId: string }
  | { kind: 'shift_budget'; fromChannel: string; toChannel: string; amount: number; campaignId: string }
  | { kind: 'reschedule'; scheduleItemId: string; toIso: string }
  | { kind: 'generate_replacement'; assetId: string; briefId: string | null }
  | { kind: 'expand_segment'; segmentId: string; threshold: number }
  | { kind: 'nudge_approver'; requestId: string }

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    title: text('title').notNull(),
    /** CC-3: every recommendation must state its reasoning and expected effect. */
    rationale: text('rationale').notNull(),
    evidence: jsonb('evidence').$type<{ label: string; value: string }[]>().notNull().default([]),
    expectedEffect: jsonb('expected_effect')
      .$type<{ metric: string; delta: string; confidence: number; horizonDays: number }>()
      .notNull(),
    priorityScore: real('priority_score').notNull().default(0),
    subjectType: varchar('subject_type', { length: 32 }),
    subjectId: uuid('subject_id'),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    action: jsonb('action').$type<RecommendationAction>().notNull(),
    /** Captured before applying so undo is exact, not approximate. */
    undoPayload: jsonb('undo_payload').$type<Record<string, unknown>>(),
    status: recStatusEnum('status').notNull().default('open'),
    appliedBy: uuid('applied_by').references(() => users.id),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recs_ws_status_idx').on(t.workspaceId, t.status, t.priorityScore)],
)

/* ------------------------------------------------------------ connectors */

export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 48 }).notNull(),
    category: varchar('category', { length: 24 }).notNull(), // crm | esp | social | ads | analytics
    displayName: text('display_name').notNull(),
    status: connectorStatusEnum('status').notNull().default('disconnected'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Never store raw secrets in app code paths; encrypted at rest. */
    credentialRef: text('credential_ref'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connectors_ws_provider_idx').on(t.workspaceId, t.provider)],
)

/* ---------------------------------------------------------------- AI ops */

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agent: varchar('agent', { length: 48 }).notNull(),
    provider: varchar('provider', { length: 24 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms').notNull().default(0),
    cacheHit: boolean('cache_hit').notNull().default(false),
    ok: boolean('ok').notNull().default(true),
    error: text('error'),
    subjectType: varchar('subject_type', { length: 32 }),
    subjectId: uuid('subject_id'),
    userId: uuid('user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_runs_ws_idx').on(t.workspaceId, t.createdAt)],
)

export const aiCache = pgTable('ai_cache', {
  key: varchar('key', { length: 64 }).primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  value: jsonb('value').notNull(),
  hits: integer('hits').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/* ------------------------------------------------------- notifications */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
)

/* ------------------------------------------------------------- billing */

export const subscriptions = pgTable('subscriptions', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  plan: planEnum('plan').notNull().default('trial'),
  status: varchar('status', { length: 24 }).notNull().default('trialing'),
  seats: integer('seats').notNull().default(3),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const usageCounters = pgTable(
  'usage_counters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    period: varchar('period', { length: 7 }).notNull(), // YYYY-MM
    metric: varchar('metric', { length: 32 }).notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => [uniqueIndex('usage_idx').on(t.workspaceId, t.period, t.metric)],
)

/* ------------------------------------------------------------ relations */

export const workspaceRelations = relations(workspaces, ({ many, one }) => ({
  memberships: many(memberships),
  campaigns: many(campaigns),
  subscription: one(subscriptions, {
    fields: [workspaces.id],
    references: [subscriptions.workspaceId],
  }),
}))

export const membershipRelations = relations(memberships, ({ one }) => ({
  workspace: one(workspaces, { fields: [memberships.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}))

export const campaignRelations = relations(campaigns, ({ many, one }) => ({
  planItems: many(planItems),
  assets: many(assets),
  owner: one(users, { fields: [campaigns.ownerId], references: [users.id] }),
}))

export const assetRelations = relations(assets, ({ one, many }) => ({
  campaign: one(campaigns, { fields: [assets.campaignId], references: [campaigns.id] }),
  brief: one(briefs, { fields: [assets.briefId], references: [briefs.id] }),
  author: one(users, { fields: [assets.createdBy], references: [users.id] }),
  versions: many(assetVersions),
}))

export const approvalRequestRelations = relations(approvalRequests, ({ many, one }) => ({
  decisions: many(approvalDecisions),
  chain: one(approvalChains, { fields: [approvalRequests.chainId], references: [approvalChains.id] }),
}))

export const scheduleRelations = relations(scheduleItems, ({ one }) => ({
  asset: one(assets, { fields: [scheduleItems.assetId], references: [assets.id] }),
  segment: one(segments, { fields: [scheduleItems.segmentId], references: [segments.id] }),
  campaign: one(campaigns, { fields: [scheduleItems.campaignId], references: [campaigns.id] }),
}))

/* ------------------------------------------------------- paid advertising */

export const adCampaignStatusEnum = pgEnum('ad_campaign_status', [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'publishing',
  'live',
  'paused',
  'ended',
  'failed',
])

/**
 * Objectives in the language a business owner uses, not Google's. Each maps to
 * a channel type and bidding strategy in src/lib/ads/objectives.ts — the
 * mapping lives in code so the reasoning is visible and testable, rather than
 * being buried in whatever the model happened to pick.
 */
export const adObjectiveEnum = pgEnum('ad_objective', [
  'sales',
  'leads',
  'traffic',
  'awareness',
])

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull().default('google_ads'),
    /** The 10-digit Google Ads customer id, stored without dashes. */
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    descriptiveName: text('descriptive_name'),
    currencyCode: varchar('currency_code', { length: 8 }).notNull().default('GBP'),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Europe/London'),
    /** Set when access is via a manager account; becomes login-customer-id. */
    managerCustomerId: varchar('manager_customer_id', { length: 32 }),
    isManager: boolean('is_manager').notNull().default(false),
    /** A test account can never spend real money — surfaced prominently in the UI. */
    testAccount: boolean('test_account').notNull().default(false),
    status: connectorStatusEnum('status').notNull().default('disconnected'),
    /** Never store the refresh token in a column a query might select by accident. */
    credentialRef: text('credential_ref'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ad_accounts_ws_customer_idx').on(t.workspaceId, t.provider, t.customerId)],
)

export type AdKeyword = {
  text: string
  matchType: 'EXACT' | 'PHRASE' | 'BROAD'
  /** Why this term is here, in plain English, for a non-marketer reviewing it. */
  rationale?: string
}

export type AdCreative = {
  /** 3-15 headlines, 30 characters each. */
  headlines: string[]
  /** 2-4 descriptions, 90 characters each. */
  descriptions: string[]
  path1?: string
  path2?: string
}

export type AdGroupPlan = {
  name: string
  /** What this group of searches has in common. */
  theme: string
  keywords: AdKeyword[]
  ads: AdCreative[]
}

export type AdCampaignStructure = {
  adGroups: AdGroupPlan[]
  /** Searches to exclude, each with the reason it would waste money. */
  negativeKeywords: { text: string; matchType: string; reason: string }[]
  sitelinks: { text: string; description1?: string; description2?: string; finalUrl: string }[]
  callouts: string[]
  /** Plain-English explanation of why the campaign is shaped this way. */
  rationale: string
}

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Optional link to the wider marketing campaign this paid activity serves. */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => adAccounts.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 32 }).notNull().default('google_ads'),

    name: text('name').notNull(),
    objective: adObjectiveEnum('objective').notNull().default('leads'),
    /** SEARCH | PERFORMANCE_MAX | DEMAND_GEN, derived from the objective. */
    channelType: varchar('channel_type', { length: 32 }).notNull().default('SEARCH'),
    status: adCampaignStatusEnum('status').notNull().default('draft'),

    /**
     * Money is held in micros (millionths of the currency unit) because that is
     * what the Google Ads API takes, and converting once at the edge avoids
     * float rounding drifting a budget by a penny per push.
     */
    dailyBudgetMicros: bigint('daily_budget_micros', { mode: 'number' }).notNull().default(0),
    currencyCode: varchar('currency_code', { length: 8 }).notNull().default('GBP'),
    biddingStrategy: varchar('bidding_strategy', { length: 40 }).notNull().default('MAXIMIZE_CONVERSIONS'),
    targetCpaMicros: bigint('target_cpa_micros', { mode: 'number' }),
    targetRoas: real('target_roas'),

    startDate: date('start_date'),
    endDate: date('end_date'),
    geoTargets: jsonb('geo_targets').$type<{ criterionId: string; name: string }[]>().notNull().default([]),
    languages: jsonb('languages').$type<string[]>().notNull().default(['en']),
    finalUrl: text('final_url'),
    /** What the business counts as success, in their own words. */
    conversionAction: text('conversion_action'),

    briefText: text('brief_text'),
    structure: jsonb('structure').$type<AdCampaignStructure>(),
    /** Competitive context the campaign was generated with, if any. Same reasoning as on briefs. */
    competitorContext: jsonb('competitor_context').$type<CompetitorContextRef>(),

    /**
     * Bumped on every edit to the plan, budget or targeting. The approval
     * request snapshots this, so editing a campaign after it was approved
     * invalidates the approval rather than quietly pushing something nobody
     * signed off — the same rule organic assets follow.
     */
    version: integer('version').notNull().default(1),

    /** Populated once the campaign exists in Google. */
    externalCampaignId: varchar('external_campaign_id', { length: 64 }),
    externalBudgetId: varchar('external_budget_id', { length: 64 }),
    externalResourceNames: jsonb('external_resource_names').$type<Record<string, string>>().notNull().default({}),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    wentLiveAt: timestamp('went_live_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),

    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ad_campaigns_ws_status_idx').on(t.workspaceId, t.status),
    index('ad_campaigns_campaign_idx').on(t.campaignId),
  ],
)

/**
 * One row per attempt to change something in Google. Kept separately from the
 * audit trail because it holds the raw request and response, which is what you
 * actually need when Google rejects an operation for a reason its error message
 * only half explains.
 */
export const adPushLog = pgTable(
  'ad_push_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    adCampaignId: uuid('ad_campaign_id')
      .notNull()
      .references(() => adCampaigns.id, { onDelete: 'cascade' }),
    action: varchar('action', { length: 40 }).notNull(),
    ok: boolean('ok').notNull().default(true),
    simulated: boolean('simulated').notNull().default(false),
    /** Google's request-id header, which their support asks for first. */
    requestId: varchar('request_id', { length: 128 }),
    operationCount: integer('operation_count').notNull().default(0),
    request: jsonb('request').$type<Record<string, unknown>>(),
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    actorId: uuid('actor_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ad_push_log_campaign_idx').on(t.adCampaignId, t.createdAt)],
)

export const adCampaignRelations = relations(adCampaigns, ({ one, many }) => ({
  account: one(adAccounts, { fields: [adCampaigns.accountId], references: [adAccounts.id] }),
  campaign: one(campaigns, { fields: [adCampaigns.campaignId], references: [campaigns.id] }),
  pushes: many(adPushLog),
}))

/* --------------------------------------------------------------- types */

export type Workspace = typeof workspaces.$inferSelect
export type User = typeof users.$inferSelect
export type Membership = typeof memberships.$inferSelect
export type Role = (typeof roleEnum.enumValues)[number]
export type Plan = (typeof planEnum.enumValues)[number]
export type Channel = (typeof channelEnum.enumValues)[number]
export type BrandProfile = typeof brandProfiles.$inferSelect
export type LegalRule = typeof legalRules.$inferSelect
export type Campaign = typeof campaigns.$inferSelect
export type PlanItem = typeof planItems.$inferSelect
export type Brief = typeof briefs.$inferSelect
export type Asset = typeof assets.$inferSelect
export type AssetStatus = (typeof assetStatusEnum.enumValues)[number]
export type Segment = typeof segments.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type ScheduleItem = typeof scheduleItems.$inferSelect
export type ApprovalChain = typeof approvalChains.$inferSelect
export type ApprovalRequest = typeof approvalRequests.$inferSelect
export type ApprovalDecision = typeof approvalDecisions.$inferSelect
export type AuditEvent = typeof auditEvents.$inferSelect
export type MetricFact = typeof metricFacts.$inferSelect
export type Recommendation = typeof recommendations.$inferSelect
/* ------------------------------------------------------- social accounts */

/**
 * A connected place we can publish to: a LinkedIn member, a LinkedIn company
 * page, or a Facebook Page.
 *
 * One row per destination rather than per platform, because a single Facebook
 * login usually administers several Pages and each carries its own token. The
 * person choosing where a post goes is choosing a row here.
 */
export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** linkedin | facebook */
    provider: varchar('provider', { length: 32 }).notNull(),
    /** The Aurea channel this publishes to: linkedin | facebook. */
    channel: varchar('channel', { length: 32 }).notNull(),

    /**
     * Whether we post as a person or as the organisation. LinkedIn needs a
     * different OAuth scope and a different author URN for each, and only the
     * organisation route requires LinkedIn's manual approval.
     */
    kind: varchar('kind', { length: 16 }).notNull().default('page'),

    /** Platform id: a LinkedIn person/organization id, or a Facebook Page id. */
    externalId: varchar('external_id', { length: 64 }).notNull(),
    /** Fully-formed author URN for LinkedIn; unused for Facebook. */
    authorUrn: text('author_urn'),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),

    /**
     * AES-256-GCM, keyed from AUTH_SECRET. Never selected into anything that
     * reaches a client component — see lib/crypto-secrets.ts for why.
     */
    accessTokenEnc: text('access_token_enc').notNull(),
    /** Last four characters, so the UI can show which token without revealing it. */
    tokenHint: varchar('token_hint', { length: 16 }),
    /** Null for Facebook Page tokens, which do not expire. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),

    status: connectorStatusEnum('status').notNull().default('connected'),
    /**
     * One Facebook login usually administers several Pages, so connecting
     * yields several rows and something has to decide which one a scheduled
     * post goes to. Making that explicit beats an implicit "most recent" rule
     * nobody can see or change.
     */
    isDefault: boolean('is_default').notNull().default(false),
    lastError: text('last_error'),
    lastPublishAt: timestamp('last_publish_at', { withTimezone: true }),

    connectedBy: uuid('connected_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('social_accounts_ws_target_idx').on(t.workspaceId, t.provider, t.externalId),
    index('social_accounts_ws_channel_idx').on(t.workspaceId, t.channel, t.status),
  ],
)

/**
 * One row per publish attempt against a real network, kept whether it worked or
 * not. The scheduler already records its own state; this is the wire-level
 * receipt — what was sent, what came back, and the platform's own post id —
 * which is what you need when someone asks why a post did or did not appear.
 */
export const socialPublishLog = pgTable(
  'social_publish_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => socialAccounts.id, { onDelete: 'set null' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    ok: boolean('ok').notNull(),
    simulated: boolean('simulated').notNull().default(false),
    /** The platform's id for the created post, e.g. a LinkedIn share urn. */
    externalRef: text('external_ref'),
    /** Public URL of the post, when the platform gives us enough to build one. */
    permalink: text('permalink'),
    httpStatus: integer('http_status'),
    request: jsonb('request'),
    response: jsonb('response'),
    error: text('error'),
    attempt: integer('attempt').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('social_publish_log_asset_idx').on(t.assetId, t.createdAt)],
)

export type Connector = typeof connectors.$inferSelect
export type AiRun = typeof aiRuns.$inferSelect
export type Notification = typeof notifications.$inferSelect
export type Subscription = typeof subscriptions.$inferSelect
export type AdAccount = typeof adAccounts.$inferSelect
export type AdCampaign = typeof adCampaigns.$inferSelect
export type AdCampaignStatus = (typeof adCampaignStatusEnum.enumValues)[number]
export type AdObjective = (typeof adObjectiveEnum.enumValues)[number]
export type AdPushLogEntry = typeof adPushLog.$inferSelect
export type SocialAccount = typeof socialAccounts.$inferSelect
export type SocialPublishLogEntry = typeof socialPublishLog.$inferSelect

/* ------------------------------------------------------- video generation */

/**
 * Generated video sits in the same governed loop as everything else, so it is
 * a subject the approval engine understands rather than a side feature. Two
 * new tables, no changes to any existing one: rolling the code back leaves
 * them unused, which costs nothing, where an altered column on a table holding
 * evidence would not.
 *
 * Money is integer cents everywhere below. The estimate is shown to a person,
 * echoed back by the client on confirmation, and compared for equality — a
 * value that can arrive as 74.99999999999999 has no business in that check.
 */

export const videoStatusEnum = pgEnum('video_status', [
  'queued', // accepted; nothing has reached a provider
  'submitted', // provider has it
  'generating', // provider reports progress
  'storing', // finished upstream, being copied into our own storage
  'ready', // stored, checksummed, mechanically checked
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'failed',
  'dead_letter',
])

export type VideoMediaFacts = {
  durationSeconds: number
  width: number
  height: number
  aspectRatio: string
  frameRate: number
  hasAudio: boolean
  byteSize: number
  container: string
  videoCodec: string | null
  audioCodec: string | null
}

export type VideoMediaCheck = {
  passed: boolean
  findings: GuardrailFinding[]
  facts: VideoMediaFacts
}

export type VideoProvenance = {
  /** e.g. 'synthid'. Recorded as fact; never asserted absent. */
  watermark: string | null
  visibleWatermark: boolean | null
  note: string | null
}

export type VideoReferenceAsset = {
  kind: 'speaker' | 'logo' | 'product' | 'scene'
  url: string
  label?: string
  instruction?: string
  likenessConfirmed?: boolean
}

export const videoGenerations = pgTable(
  'video_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    briefId: uuid('brief_id').references(() => briefs.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /** Lineage. Regenerating makes a new row with the same lineage and version+1. */
    lineageId: uuid('lineage_id').notNull(),
    version: integer('version').notNull().default(1),

    title: text('title').notNull(),
    status: videoStatusEnum('status').notNull().default('queued'),
    stage: pipelineStageEnum('stage').notNull().default('generate'),

    providerId: varchar('provider_id', { length: 24 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    providerJobId: text('provider_job_id'),
    /** True for anything the simulator produced. Shown in the UI, always. */
    simulated: boolean('simulated').notNull().default(false),
    /** Set when the fallback provider served the request rather than the primary. */
    failedOverFrom: varchar('failed_over_from', { length: 24 }),

    prompt: text('prompt').notNull(),
    /** sha256 of the prompt. The audit payload carries this, not the prompt. */
    promptHash: varchar('prompt_hash', { length: 64 }).notNull(),
    script: text('script'),
    negativePrompt: text('negative_prompt'),
    referenceAssets: jsonb('reference_assets').$type<VideoReferenceAsset[]>().notNull().default([]),

    channel: channelEnum('channel'),
    aspectRatio: varchar('aspect_ratio', { length: 8 }).notNull(),
    resolution: varchar('resolution', { length: 8 }).notNull(),
    durationSeconds: real('duration_seconds').notNull(),
    audio: boolean('audio').notNull().default(false),
    seed: integer('seed'),

    estimatedCostCents: integer('estimated_cost_cents').notNull(),
    actualCostCents: integer('actual_cost_cents'),
    /** Who confirmed the figure, and the figure they were shown. */
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
    acknowledgedCostCents: integer('acknowledged_cost_cents'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),

    storageKey: text('storage_key'),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),

    /** The pre-generation score, from the same guardrails organic copy uses. */
    scoreDetail: jsonb('score_detail').$type<ScoreDetail>(),
    mediaFacts: jsonb('media_facts').$type<VideoMediaFacts>(),
    mediaCheck: jsonb('media_check').$type<VideoMediaCheck>(),
    provenance: jsonb('provenance').$type<VideoProvenance>(),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    /** When the provider deletes its copy. Veo: 48 hours. */
    providerExpiresAt: timestamp('provider_expires_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('video_ws_status_idx').on(t.workspaceId, t.status),
    index('video_brief_idx').on(t.briefId),
    /** Supports the month-to-date spend query without a sequential scan. */
    index('video_spend_idx').on(t.workspaceId, t.createdAt),
    /** In-flight rows the worker picks up. */
    index('video_inflight_idx').on(t.status, t.nextRetryAt),
    /**
     * One version per lineage. This is what makes "approval binds to a version"
     * enforceable in the database rather than only in application code.
     */
    uniqueIndex('video_lineage_version_idx').on(t.lineageId, t.version),
  ],
)

/**
 * The monthly video ceiling, appended rather than overwritten.
 *
 * Raising a ceiling is a spend decision. Who raised it, when, from what to
 * what, and why is exactly the sort of thing that should not be an UPDATE on a
 * single row — the same reasoning that makes the audit table append-only.
 */
export const videoBudgets = pgTable(
  'video_budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ceilingCents: integer('ceiling_cents').notNull(),
    previousCeilingCents: integer('previous_ceiling_cents'),
    reason: text('reason'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    setBy: uuid('set_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('video_budget_current_idx').on(t.workspaceId, t.effectiveFrom)],
)

export const videoRelations = relations(videoGenerations, ({ one }) => ({
  brief: one(briefs, { fields: [videoGenerations.briefId], references: [briefs.id] }),
  campaign: one(campaigns, { fields: [videoGenerations.campaignId], references: [campaigns.id] }),
  author: one(users, { fields: [videoGenerations.createdBy], references: [users.id] }),
}))

export type VideoGeneration = typeof videoGenerations.$inferSelect
export type VideoStatus = (typeof videoStatusEnum.enumValues)[number]
export type VideoBudget = typeof videoBudgets.$inferSelect

/* ------------------------------------------------------ SERP Twin (PPC + SEO) */

/**
 * One analysis of a workspace's paid and organic search, stored whole.
 *
 * The report is the output of a pure function over the input rows, so it is
 * kept verbatim with its sha256. An approved recommendation points back at the
 * run it came from, and anyone can re-hash the report to confirm the evidence
 * a reviewer saw is the evidence that is still on file.
 */
export const serpTwinRuns = pgTable(
  'serp_twin_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 'simulated' until Google Ads and Search Console are connected. Shown in the UI, always. */
    source: varchar('source', { length: 16 }).notNull(),
    seed: integer('seed'),
    windowStart: date('window_start'),
    windowEnd: date('window_end'),
    report: jsonb('report').$type<SerpTwinReport>().notNull(),
    reportHash: varchar('report_hash', { length: 64 }).notNull(),
    recommendationCount: integer('recommendation_count').notNull().default(0),
    monthlyImpact: real('monthly_impact').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('serp_twin_runs_ws_idx').on(t.workspaceId, t.createdAt)],
)

/**
 * A recommendation someone has picked up: sent for approval, approved,
 * applied, or reverted. Created on first use rather than for every finding,
 * so the table holds decisions, not the whole report again.
 *
 * `recommendation` is a snapshot. The approval binds to `version`; nothing in
 * the snapshot can change after submission without a new version.
 */
export const serpTwinActions = pgTable(
  'serp_twin_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => serpTwinRuns.id, { onDelete: 'cascade' }),
    recommendationId: varchar('recommendation_id', { length: 64 }).notNull(),
    engine: varchar('engine', { length: 16 }).notNull(),
    title: text('title').notNull(),
    confidence: varchar('confidence', { length: 16 }).notNull(),
    monthlyImpact: real('monthly_impact').notNull().default(0),
    recommendation: jsonb('recommendation').$type<SerpTwinRecommendation>().notNull(),
    /** draft → in_review → approved → applied → reverted, or changes_requested. */
    status: varchar('status', { length: 24 }).notNull().default('draft'),
    version: integer('version').notNull().default(1),
    simulated: boolean('simulated').notNull().default(true),
    /** Content Studio brief created from this recommendation, if any. */
    briefId: uuid('brief_id').references(() => briefs.id, { onDelete: 'set null' }),
    appliedBy: uuid('applied_by').references(() => users.id),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('serp_twin_actions_run_rec_idx').on(t.runId, t.recommendationId),
    index('serp_twin_actions_ws_idx').on(t.workspaceId, t.status),
  ],
)

export type SerpTwinRun = typeof serpTwinRuns.$inferSelect
export type SerpTwinAction = typeof serpTwinActions.$inferSelect

/**
 * What the business sells, what a customer is worth and what the team can
 * take on. Stated by a person in PPC & SEO → Business setup; the lead, budget
 * and SEO engines read it and never infer it.
 */
export const serpTwinProfiles = pgTable('serp_twin_profiles', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  profile: jsonb('profile').$type<SerpTwinBusinessProfile>().notNull(),
  /** Which simulated account runs use until Google Ads and Search Console are connected. */
  dataset: varchar('dataset', { length: 40 }).notNull().default('cy-group'),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Enquiries and what became of them. Sales update the outcome in one click;
 * the next analysis reads it. Personal data: kept to what classification
 * needs, and erased with the workspace.
 */
export const searchLeads = pgTable(
  'search_leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 64 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    source: varchar('source', { length: 16 }).notNull(),
    gclid: text('gclid'),
    campaignId: varchar('campaign_id', { length: 64 }),
    adGroupId: varchar('ad_group_id', { length: 64 }),
    searchTerm: text('search_term'),
    landingPage: text('landing_page'),
    serviceId: varchar('service_id', { length: 64 }),
    message: text('message').notNull().default(''),
    email: text('email'),
    phone: text('phone'),
    locationCountry: varchar('location_country', { length: 2 }),
    locationArea: varchar('location_area', { length: 8 }),
    signals: jsonb('signals').$type<NonNullable<SerpTwinLead['signals']>>(),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    contactAttempts: integer('contact_attempts').notNull().default(0),
    outcome: varchar('outcome', { length: 16 }).notNull().default('open'),
    lostReason: text('lost_reason'),
    value: real('value'),
    simulated: boolean('simulated').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_leads_ws_ext_idx').on(t.workspaceId, t.externalId),
    index('search_leads_ws_received_idx').on(t.workspaceId, t.receivedAt),
  ],
)

export type SearchLead = typeof searchLeads.$inferSelect

/* --------------------------------------------------- Competitor intelligence */

/**
 * What a generator was told about the competition. `text` is the exact block
 * placed in the prompt; the ids say which landscape it was cut from.
 */
export type CompetitorContextRef = {
  landscapeId: string
  generatedAt: string
  competitorIds: string[]
  text: string
  /** Brand names the copy must not use, also fed to the guardrail. */
  brandNames: string[]
}

/**
 * Who the business is, for competitor discovery: the register entry, the
 * search terms customers use and how far afield it competes. One per
 * workspace. Stated or confirmed by a person; discovery reads it.
 */
export const competitorProfiles = pgTable('competitor_profiles', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  profile: jsonb('profile').$type<CompetitorCompanyProfile>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A business that competes for the same customers. Discovery suggests;
 * a person tracks or dismisses. Dismissed rows are kept so the next discovery
 * does not suggest the same business again.
 */
export const competitors = pgTable(
  'competitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Identity across sources: domain, else place id, else company number, else name. */
    key: varchar('key', { length: 200 }).notNull(),
    name: text('name').notNull(),
    domain: varchar('domain', { length: 200 }),
    placeId: varchar('place_id', { length: 200 }),
    companyNumber: varchar('company_number', { length: 16 }),
    kind: varchar('kind', { length: 16 }).notNull().default('direct'),
    tier: varchar('tier', { length: 16 }).notNull().default('national'),
    /** suggested → tracked, or dismissed. */
    status: varchar('status', { length: 16 }).notNull().default('suggested'),
    relevance: integer('relevance').notNull().default(0),
    candidate: jsonb('candidate').$type<CompetitorCandidate>().notNull(),
    threatScore: integer('threat_score'),
    simulated: boolean('simulated').notNull().default(false),
    lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('competitors_ws_key_idx').on(t.workspaceId, t.key),
    index('competitors_ws_status_idx').on(t.workspaceId, t.status),
  ],
)

/**
 * One read of a business's online presence, stored whole with its sha256 so
 * the evidence behind an insight can be shown and re-verified later. The
 * business's own site is scanned the same way, with `competitorId` null.
 */
export const competitorScans = pgTable(
  'competitor_scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    competitorId: uuid('competitor_id').references(() => competitors.id, { onDelete: 'cascade' }),
    isSelf: boolean('is_self').notNull().default(false),
    snapshot: jsonb('snapshot').$type<CompetitorSnapshot>().notNull(),
    analysis: jsonb('analysis').$type<CompetitorAnalysis>(),
    /** What changed since the previous scan of the same business. */
    changes: jsonb('changes').$type<CompetitorChange[]>().notNull().default([]),
    snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
    simulated: boolean('simulated').notNull().default(false),
    durationMs: integer('duration_ms'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('competitor_scans_ws_idx').on(t.workspaceId, t.createdAt),
    index('competitor_scans_comp_idx').on(t.competitorId, t.createdAt),
  ],
)

/**
 * The cross-competitor read: claims, search share, content and channel gaps,
 * customer pain points, and the plays that follow. Built from the latest scan
 * of every tracked competitor plus the business's own.
 */
export const competitorLandscapes = pgTable(
  'competitor_landscapes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    report: jsonb('report').$type<CompetitorLandscapeReport>().notNull(),
    reportHash: varchar('report_hash', { length: 64 }).notNull(),
    simulated: boolean('simulated').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('competitor_landscapes_ws_idx').on(t.workspaceId, t.createdAt)],
)

export type Competitor = typeof competitors.$inferSelect
export type CompetitorScan = typeof competitorScans.$inferSelect
export type CompetitorLandscape = typeof competitorLandscapes.$inferSelect


/* ------------------------------------------------------- budget allocator */

/**
 * A budget plan for one period: the envelope, its objective and the settings
 * the allocator uses. Plans are governed like campaigns — submitted through
 * the approval engine, bound to a version, and only an approved plan can be
 * activated. A reallocation of an active plan is a new plan (a revision, with
 * `parentPlanId`), so what was approved and what replaced it are both kept.
 */
export const budgetPlans = pgTable(
  'budget_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('GBP'),
    totalPence: bigint('total_pence', { mode: 'number' }).notNull(),
    /** conversions | revenue | profit */
    objective: varchar('objective', { length: 16 }).notNull().default('conversions'),
    riskAversion: real('risk_aversion').notNull().default(0.5),
    learningShare: real('learning_share').notNull().default(0.05),
    maxShift: real('max_shift').default(0.3),
    valuePerConversionPence: integer('value_per_conversion_pence'),
    /** Card limit to forecast against, if the card has one. */
    cardLimitPence: bigint('card_limit_pence', { mode: 'number' }),
    /** draft → in_review → approved → active → superseded | closed; changes_requested on rejection. */
    status: varchar('status', { length: 24 }).notNull().default('draft'),
    version: integer('version').notNull().default(1),
    parentPlanId: uuid('parent_plan_id'),
    notes: text('notes'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedBy: uuid('activated_by').references(() => users.id),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('budget_plans_ws_idx').on(t.workspaceId, t.status, t.periodStart)],
)

/** One line of a plan: a channel or a cost, with its limits and links. */
export const budgetLines = pgTable(
  'budget_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => budgetPlans.id, { onDelete: 'cascade' }),
    channelKey: varchar('channel_key', { length: 48 }).notNull(),
    label: text('label').notNull(),
    category: varchar('category', { length: 24 }).notNull(),
    plannedPence: bigint('planned_pence', { mode: 'number' }).notNull().default(0),
    minPence: bigint('min_pence', { mode: 'number' }).notNull().default(0),
    maxPence: bigint('max_pence', { mode: 'number' }),
    locked: boolean('locked').notNull().default(false),
    allowExtrapolation: boolean('allow_extrapolation').notNull().default(false),
    /** Share of reported outcomes that are incremental, and where that number came from. */
    incrementality: real('incrementality').notNull().default(1),
    incrementalitySource: text('incrementality_source'),
    /** Aurea Google Ads campaigns this line pays for. */
    adCampaignIds: jsonb('ad_campaign_ids').$type<string[]>().notNull().default([]),
    ownerId: uuid('owner_id').references(() => users.id),
    sort: integer('sort').notNull().default(0),
    notes: text('notes'),
  },
  (t) => [
    index('budget_lines_plan_idx').on(t.planId, t.sort),
    uniqueIndex('budget_lines_plan_channel_idx').on(t.planId, t.channelKey),
  ],
)

/** Weekly spend and outcomes per channel: what the curves are fitted on. */
export const budgetObservations = pgTable(
  'budget_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelKey: varchar('channel_key', { length: 48 }).notNull(),
    weekStart: date('week_start').notNull(),
    spendPence: bigint('spend_pence', { mode: 'number' }).notNull().default(0),
    conversions: real('conversions').notNull().default(0),
    revenuePence: bigint('revenue_pence', { mode: 'number' }).notNull().default(0),
    /** aurea | platform | statement | manual | simulated */
    source: varchar('source', { length: 16 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('budget_obs_idx').on(t.workspaceId, t.channelKey, t.weekStart, t.source)],
)

/** Platform-reported (accrual) spend per day: the "platform" leg of the three-way match. */
export const budgetPlatformSpend = pgTable(
  'budget_platform_spend',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 48 }).notNull(),
    day: date('day').notNull(),
    spendPence: bigint('spend_pence', { mode: 'number' }).notNull().default(0),
    source: varchar('source', { length: 16 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('budget_platform_spend_idx').on(t.workspaceId, t.platform, t.day, t.source)],
)

/**
 * One allocator run: the settings, the curves and the recommendation, stored
 * whole with a sha256 — the figures a reviewer approves are the figures that
 * were computed, and the run can be reproduced from its seed.
 */
export const budgetAllocations = pgTable(
  'budget_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => budgetPlans.id, { onDelete: 'cascade' }),
    planVersion: integer('plan_version').notNull(),
    settings: jsonb('settings').$type<BudgetAllocationSettings>().notNull(),
    curves: jsonb('curves').$type<BudgetStoredCurve[]>().notNull().default([]),
    result: jsonb('result').$type<BudgetAllocationResult>().notNull(),
    resultHash: varchar('result_hash', { length: 64 }).notNull(),
    simulated: boolean('simulated').notNull().default(false),
    /** The revision plan created from this run, once applied. */
    appliedPlanId: uuid('applied_plan_id'),
    appliedBy: uuid('applied_by').references(() => users.id),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('budget_allocations_plan_idx').on(t.planId, t.createdAt)],
)

/**
 * A payment card connected to the budget. Never a card number: last four
 * digits and the provider's own reference only, so Aurea stays out of PCI DSS
 * scope. Tokens and keys are encrypted (crypto-secrets) in credentialRef.
 */
export const paymentCards = pgTable(
  'payment_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** simulated | csv | truelayer | airwallex */
    provider: varchar('provider', { length: 24 }).notNull(),
    label: text('label').notNull(),
    last4: varchar('last4', { length: 4 }),
    network: varchar('network', { length: 24 }),
    currency: varchar('currency', { length: 8 }).notNull().default('GBP'),
    /** The provider's id for the card or card account. */
    externalId: varchar('external_id', { length: 128 }),
    monthlyLimitPence: bigint('monthly_limit_pence', { mode: 'number' }),
    /** A card dedicated to one channel: every charge on it belongs to that line. */
    channelKey: varchar('channel_key', { length: 48 }),
    status: connectorStatusEnum('status').notNull().default('connected'),
    credentialRef: text('credential_ref'),
    /** UK Open Banking: the customer must reconfirm access every 90 days. */
    consentExpiresAt: timestamp('consent_expires_at', { withTimezone: true }),
    simulated: boolean('simulated').notNull().default(false),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_cards_ws_idx').on(t.workspaceId),
    // Reconnecting a card (UK Open Banking every 90 days) must reuse its row, or every charge is counted twice.
    uniqueIndex('payment_cards_ws_provider_ext_idx').on(t.workspaceId, t.provider, t.externalId),
  ],
)

/** Card transactions, normalised and classified. Deduplicated on Aurea's own key. */
export const cardTransactions = pgTable(
  'card_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => paymentCards.id, { onDelete: 'cascade' }),
    /** merchants.txKey: stable even when the provider's own id changes. */
    externalId: varchar('external_id', { length: 64 }).notNull(),
    providerTxId: varchar('provider_tx_id', { length: 128 }),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    amountPence: bigint('amount_pence', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('GBP'),
    originalAmountMinor: bigint('original_amount_minor', { mode: 'number' }),
    originalCurrency: varchar('original_currency', { length: 8 }),
    descriptor: text('descriptor').notNull(),
    /** pending | settled */
    status: varchar('status', { length: 12 }).notNull().default('settled'),
    channelKey: varchar('channel_key', { length: 48 }),
    /** Set by a person; otherwise the line follows the channel. */
    lineChannelKey: varchar('line_channel_key', { length: 48 }),
    accountRef: varchar('account_ref', { length: 32 }),
    classifiedVia: varchar('classified_via', { length: 12 }).notNull().default('none'),
    ignored: boolean('ignored').notNull().default(false),
    simulated: boolean('simulated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('card_tx_card_ext_idx').on(t.cardId, t.externalId),
    index('card_tx_ws_posted_idx').on(t.workspaceId, t.postedAt),
  ],
)

/** "This descriptor is that line" — taught by a person, applied to every future charge. */
export const merchantRules = pgTable(
  'merchant_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contains: varchar('contains', { length: 80 }).notNull(),
    channelKey: varchar('channel_key', { length: 48 }),
    ignore: boolean('ignore').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('merchant_rules_ws_contains_idx').on(t.workspaceId, t.contains)],
)

/** One reconciliation run, stored whole with its sha256. */
export const budgetReconciliations = pgTable(
  'budget_reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => budgetPlans.id, { onDelete: 'cascade' }),
    report: jsonb('report').$type<BudgetReconciliationReport>().notNull(),
    reportHash: varchar('report_hash', { length: 64 }).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('budget_recon_plan_idx').on(t.planId, t.createdAt)],
)

/**
 * A discrepancy, kept across runs by its fingerprint so that a person's
 * "explained" or "resolved" sticks, and so that one reappearing after it was
 * resolved is noticed.
 */
export const budgetDiscrepancies = pgTable(
  'budget_discrepancies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => budgetPlans.id, { onDelete: 'cascade' }),
    fingerprint: varchar('fingerprint', { length: 32 }).notNull(),
    kind: varchar('kind', { length: 24 }).notNull(),
    severity: varchar('severity', { length: 8 }).notNull(),
    platform: varchar('platform', { length: 48 }),
    lineId: uuid('line_id'),
    amountPence: bigint('amount_pence', { mode: 'number' }).notNull().default(0),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    suggestion: text('suggestion').notNull(),
    txIds: jsonb('tx_ids').$type<string[]>().notNull().default([]),
    /** open | explained | resolved — and gone when a run no longer finds it. */
    status: varchar('status', { length: 12 }).notNull().default('open'),
    present: boolean('present').notNull().default(true),
    note: text('note'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('budget_disc_fp_idx').on(t.planId, t.fingerprint),
    index('budget_disc_ws_idx').on(t.workspaceId, t.status),
  ],
)

export type BudgetPlan = typeof budgetPlans.$inferSelect
export type BudgetLine = typeof budgetLines.$inferSelect
export type PaymentCard = typeof paymentCards.$inferSelect
export type CardTransaction = typeof cardTransactions.$inferSelect
export type BudgetDiscrepancy = typeof budgetDiscrepancies.$inferSelect
export type BudgetAllocation = typeof budgetAllocations.$inferSelect

/* ------------------------------------------------------------ growth agent */

/**
 * How a workspace's growth agent reaches the outside world. One row per
 * workspace. Tokens are encrypted (crypto-secrets); the CRM token is the
 * CRM's own scoped agent token, so revoking it in the CRM cuts the agent off
 * whatever this table says.
 */
export const agentConnections = pgTable('agent_connections', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  crmUrl: text('crm_url'),
  crmTokenEnc: text('crm_token_enc'),
  crmBusinessId: integer('crm_business_id'),
  crmBusinessName: text('crm_business_name'),
  crmScopes: jsonb('crm_scopes').$type<string[]>().notNull().default([]),
  githubRepo: varchar('github_repo', { length: 200 }),
  githubTokenEnc: text('github_token_enc'),
  /** Which routines run on their own. Outreach also needs the CRM's own switch. */
  schedule: jsonb('schedule')
    .$type<{ dailyBrief: boolean; findLeads: boolean; outreach: boolean }>()
    .notNull()
    .default({ dailyBrief: true, findLeads: false, outreach: false }),
  /** Lead-finding targets: SIC codes, Companies House locations, sections to exclude. */
  targets: jsonb('targets')
    .$type<{ sicCodes: string[]; locations: string[]; excludedSections: string[]; incorporatedFrom?: string | null }>()
    .notNull()
    .default({ sicCodes: [], locations: [], excludedSections: [] }),
  /** What a person told the agent about the business: owner-confirmed facts. */
  answers: jsonb('answers').$type<Record<string, string>>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One run of the agent: a routine (brief, leads, outreach, content) or a
 * person's question. The whole record is kept: every step, every piece of
 * evidence, what it proposed, and any sentence removed from its report for
 * lack of evidence. Runs are stored with simulated = true when no model key
 * is configured.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    goal: varchar('goal', { length: 24 }).notNull(),
    question: text('question'),
    trigger: varchar('trigger', { length: 12 }).notNull().default('manual'),
    status: varchar('status', { length: 12 }).notNull().default('running'),
    model: varchar('model', { length: 64 }),
    simulated: boolean('simulated').notNull().default(false),
    report: text('report'),
    dropped: jsonb('dropped').$type<{ sentence: string; why: string }[]>().notNull().default([]),
    steps: jsonb('steps').$type<AgentStoredStep[]>().notNull().default([]),
    proposals: jsonb('proposals').$type<AgentStoredProposal[]>().notNull().default([]),
    evidence: jsonb('evidence').$type<AgentStoredEvidence[]>().notNull().default([]),
    usage: jsonb('usage').$type<{ input: number; output: number }>().notNull().default({ input: 0, output: 0 }),
    stoppedBecause: varchar('stopped_because', { length: 24 }),
    error: text('error'),
    startedBy: uuid('started_by').references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_runs_ws_idx').on(t.workspaceId, t.startedAt), index('agent_runs_goal_idx').on(t.workspaceId, t.goal, t.startedAt)],
)

export type AgentStoredStep = { n: number; tool?: string; tier?: string; ok: boolean; summary: string; evidenceIds: string[]; ms: number }
export type AgentStoredProposal = { kind: string; title: string; url?: string; ref?: string; status: string }
export type AgentStoredEvidence = { id: string; source: string; label: string; url?: string; observedAt: string }
export type AgentConnection = typeof agentConnections.$inferSelect
export type AgentRun = typeof agentRuns.$inferSelect
