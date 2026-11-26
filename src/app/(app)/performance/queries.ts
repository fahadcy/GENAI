import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { assets, campaigns, metricFacts, scheduleItems } from '@/lib/db/schema'

/**
 * Performance & optimisation — the read model (PF-1, PF-2).
 *
 * Everything on the screen is aggregated out of `metric_facts`, the daily fact
 * table, so a number shown in a KPI tile, a chart and a CSV export can never
 * disagree: they are all the same sum over the same window.
 *
 * Two windows are in play everywhere:
 *   current  = the last N days including today
 *   previous = the N days immediately before that
 * The pair is what makes every headline number carry a real period-over-period
 * delta rather than a decorative arrow.
 */

export const RANGE_OPTIONS = [7, 30, 90] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]

export function parseRange(raw: string | string[] | undefined): RangeDays {
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return (RANGE_OPTIONS as readonly number[]).includes(n) ? (n as RangeDays) : 30
}

/**
 * Day offsets are interpolated as literals rather than bound parameters:
 * Postgres cannot infer a type for `date - $1`, and `days` is already narrowed
 * to one of three constants by `parseRange`, so there is nothing to inject.
 */
const back = (n: number) => sql.raw(String(n))

/** `day` sits inside the current window. */
const inCurrent = (days: RangeDays) => sql`${metricFacts.day} >= current_date - ${back(days - 1)}`
/** `day` sits inside the window immediately before the current one. */
const inPrevious = (days: RangeDays) =>
  sql`${metricFacts.day} >= current_date - ${back(2 * days - 1)} and ${metricFacts.day} < current_date - ${back(days - 1)}`
/** Both windows together — the cheapest `where` that still feeds the deltas. */
const inBoth = (days: RangeDays) => sql`${metricFacts.day} >= current_date - ${back(2 * days - 1)}`

/* ------------------------------------------------------------------- KPIs */

export type PerformanceTotals = {
  impressions: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  pipeline: number
  prevImpressions: number
  prevClicks: number
  prevConversions: number
  prevSignups: number
  prevSpend: number
  prevRevenue: number
  prevPipeline: number
  /** Distinct days that actually carry facts, per window. */
  measuredDays: number
  prevMeasuredDays: number
}

/** PF-1: one set of totals for every channel, tied to spend and pipeline. */
export async function performanceTotals(
  workspaceId: string,
  days: RangeDays,
): Promise<PerformanceTotals> {
  const cur = inCurrent(days)
  const prev = inPrevious(days)
  const [row] = await db
    .select({
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${cur}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricFacts.clicks}) filter (where ${cur}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}) filter (where ${cur}), 0)::int`,
      signups: sql<number>`coalesce(sum(${metricFacts.signups}) filter (where ${cur}), 0)::int`,
      spend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${cur}), 0)::float`,
      revenue: sql<number>`coalesce(sum(${metricFacts.revenue}) filter (where ${cur}), 0)::float`,
      pipeline: sql<number>`coalesce(sum(${metricFacts.pipeline}) filter (where ${cur}), 0)::float`,
      prevImpressions: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${prev}), 0)::int`,
      prevClicks: sql<number>`coalesce(sum(${metricFacts.clicks}) filter (where ${prev}), 0)::int`,
      prevConversions: sql<number>`coalesce(sum(${metricFacts.conversions}) filter (where ${prev}), 0)::int`,
      prevSignups: sql<number>`coalesce(sum(${metricFacts.signups}) filter (where ${prev}), 0)::int`,
      prevSpend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${prev}), 0)::float`,
      prevRevenue: sql<number>`coalesce(sum(${metricFacts.revenue}) filter (where ${prev}), 0)::float`,
      prevPipeline: sql<number>`coalesce(sum(${metricFacts.pipeline}) filter (where ${prev}), 0)::float`,
      measuredDays: sql<number>`count(distinct ${metricFacts.day}) filter (where ${cur})::int`,
      prevMeasuredDays: sql<number>`count(distinct ${metricFacts.day}) filter (where ${prev})::int`,
    })
    .from(metricFacts)
    .where(
      and(
        eq(metricFacts.workspaceId, workspaceId),
        inBoth(days),
      ),
    )

  return (
    row ?? {
      impressions: 0, clicks: 0, conversions: 0, signups: 0, spend: 0, revenue: 0, pipeline: 0,
      prevImpressions: 0, prevClicks: 0, prevConversions: 0, prevSignups: 0, prevSpend: 0,
      prevRevenue: 0, prevPipeline: 0, measuredDays: 0, prevMeasuredDays: 0,
    }
  )
}

/* ------------------------------------------------------------------ trend */

export type TrendPoint = {
  bucket: string
  signups: number
  conversions: number
  spend: number
  /** Blended: all spend in the bucket over all signups in the bucket. */
  costPerSignup: number | null
}

/**
 * Daily up to 30 days; weekly beyond that. Ninety daily points on a line reads
 * as noise — the weekday/weekend cycle drowns the trend — so the 90-day view
 * aggregates to ISO weeks and says so on the axis.
 */
export async function performanceTrend(
  workspaceId: string,
  days: RangeDays,
): Promise<{ points: TrendPoint[]; grain: 'day' | 'week' }> {
  const grain: 'day' | 'week' = days > 30 ? 'week' : 'day'
  const bucket =
    grain === 'week'
      ? sql<string>`date_trunc('week', ${metricFacts.day})::date::text`
      : sql<string>`${metricFacts.day}::text`

  const rows = await db
    .select({
      bucket,
      signups: sql<number>`sum(${metricFacts.signups})::int`,
      conversions: sql<number>`sum(${metricFacts.conversions})::int`,
      spend: sql<number>`sum(${metricFacts.spend})::float`,
    })
    .from(metricFacts)
    .where(and(eq(metricFacts.workspaceId, workspaceId), inCurrent(days)))
    .groupBy(bucket)
    .orderBy(bucket)

  return {
    grain,
    points: rows.map((r) => ({
      bucket: r.bucket,
      signups: r.signups,
      conversions: r.conversions,
      spend: r.spend,
      costPerSignup: r.signups > 0 && r.spend > 0 ? r.spend / r.signups : null,
    })),
  }
}

/* ------------------------------------------------------- channel scorecard */

export type ChannelRow = {
  channel: string
  impressions: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  pipeline: number
  prevSpend: number
  prevConversions: number
}

/** PF-1/PF-5: the table the CSV export is generated from, client-side. */
export async function channelScorecard(
  workspaceId: string,
  days: RangeDays,
): Promise<ChannelRow[]> {
  const cur = inCurrent(days)
  const prev = inPrevious(days)
  const rows = await db
    .select({
      channel: metricFacts.channel,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${cur}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricFacts.clicks}) filter (where ${cur}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}) filter (where ${cur}), 0)::int`,
      signups: sql<number>`coalesce(sum(${metricFacts.signups}) filter (where ${cur}), 0)::int`,
      spend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${cur}), 0)::float`,
      revenue: sql<number>`coalesce(sum(${metricFacts.revenue}) filter (where ${cur}), 0)::float`,
      pipeline: sql<number>`coalesce(sum(${metricFacts.pipeline}) filter (where ${cur}), 0)::float`,
      prevSpend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${prev}), 0)::float`,
      prevConversions: sql<number>`coalesce(sum(${metricFacts.conversions}) filter (where ${prev}), 0)::int`,
    })
    .from(metricFacts)
    .where(
      and(
        eq(metricFacts.workspaceId, workspaceId),
        inBoth(days),
      ),
    )
    .groupBy(metricFacts.channel)

  // A channel with no activity in the current window is not a scorecard row —
  // it would sort to the bottom as a line of zeroes and add nothing.
  return rows.filter((r) => r.impressions > 0).sort((a, b) => b.conversions - a.conversions)
}

/* ---------------------------------------------------- campaign attribution */

export type CampaignRow = {
  campaignId: string
  name: string
  status: string
  objective: string
  goalMetric: string
  targetValue: number | null
  budget: number
  impressions: number
  opens: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  pipeline: number
}

/** PF-2: results attributed back to the campaign that asked for them. */
export async function campaignAttribution(
  workspaceId: string,
  days: RangeDays,
): Promise<CampaignRow[]> {
  const rows = await db
    .select({
      campaignId: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      objective: campaigns.objective,
      goalMetric: campaigns.goalMetric,
      targetValue: campaigns.targetValue,
      budget: sql<number>`${campaigns.budget}::float`,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}), 0)::int`,
      opens: sql<number>`coalesce(sum(${metricFacts.opens}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricFacts.clicks}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}), 0)::int`,
      signups: sql<number>`coalesce(sum(${metricFacts.signups}), 0)::int`,
      spend: sql<number>`coalesce(sum(${metricFacts.spend}), 0)::float`,
      revenue: sql<number>`coalesce(sum(${metricFacts.revenue}), 0)::float`,
      pipeline: sql<number>`coalesce(sum(${metricFacts.pipeline}), 0)::float`,
    })
    .from(metricFacts)
    .innerJoin(campaigns, eq(campaigns.id, metricFacts.campaignId))
    .where(and(eq(metricFacts.workspaceId, workspaceId), inCurrent(days)))
    .groupBy(
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.objective,
      campaigns.goalMetric,
      campaigns.targetValue,
      campaigns.budget,
    )

  return rows.sort((a, b) => b.conversions - a.conversions)
}

/* ------------------------------------------------------ asset performance */

export type AssetRow = {
  assetId: string
  title: string
  channel: string
  campaignId: string | null
  campaignName: string | null
  impressions: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  /** CTR over the last three days — the fatigue probe. */
  recentCtr: number | null
  /** CTR over the fourteen days before that — the asset's own baseline. */
  baselineCtr: number | null
  /** Fractional change of recentCtr against baselineCtr; null when too thin. */
  ctrDelta: number | null
}

/**
 * PF-3: per-asset results plus the same fatigue probe the copilot's detector
 * uses (`src/lib/copilot/analyze.ts`) — last 3 days of CTR against the 14 days
 * before them. Keeping the windows identical means the table and the copilot's
 * finding can never tell different stories about the same asset.
 *
 * The fatigue windows are deliberately fixed rather than following the range
 * control: fatigue is a "right now" question, and stretching the probe to 90
 * days would average the collapse away.
 */
export async function assetPerformance(workspaceId: string, days: RangeDays): Promise<AssetRow[]> {
  const cur = inCurrent(days)
  const rows = await db
    .select({
      assetId: assets.id,
      title: assets.title,
      channel: assets.channel,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${cur}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricFacts.clicks}) filter (where ${cur}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}) filter (where ${cur}), 0)::int`,
      signups: sql<number>`coalesce(sum(${metricFacts.signups}) filter (where ${cur}), 0)::int`,
      spend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${cur}), 0)::float`,
      revenue: sql<number>`coalesce(sum(${metricFacts.revenue}) filter (where ${cur}), 0)::float`,
      recentImpr: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${metricFacts.day} >= current_date - 3), 0)::int`,
      recentClicks: sql<number>`coalesce(sum(${metricFacts.clicks}) filter (where ${metricFacts.day} >= current_date - 3), 0)::int`,
      baseImpr: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${metricFacts.day} < current_date - 3 and ${metricFacts.day} >= current_date - 17), 0)::int`,
      baseClicks: sql<number>`coalesce(sum(${metricFacts.clicks}) filter (where ${metricFacts.day} < current_date - 3 and ${metricFacts.day} >= current_date - 17), 0)::int`,
    })
    .from(metricFacts)
    .innerJoin(assets, eq(assets.id, metricFacts.assetId))
    .leftJoin(campaigns, eq(campaigns.id, metricFacts.campaignId))
    .where(
      and(
        eq(metricFacts.workspaceId, workspaceId),
        sql`${metricFacts.day} >= least(current_date - ${back(days - 1)}, current_date - 17)`,
      ),
    )
    .groupBy(assets.id, assets.title, assets.channel, campaigns.id, campaigns.name)

  return rows
    .filter((r) => r.impressions > 0)
    .map((r) => {
      // Same volume gates as the copilot detector: below them a CTR ratio is
      // noise, and showing it as a signal would be dishonest.
      const enough = r.recentImpr >= 400 && r.baseImpr >= 800
      const recentCtr = r.recentImpr > 0 ? r.recentClicks / r.recentImpr : null
      const baselineCtr = r.baseImpr > 0 ? r.baseClicks / r.baseImpr : null
      return {
        assetId: r.assetId,
        title: r.title,
        channel: r.channel as string,
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        impressions: r.impressions,
        clicks: r.clicks,
        conversions: r.conversions,
        signups: r.signups,
        spend: r.spend,
        revenue: r.revenue,
        recentCtr,
        baselineCtr,
        ctrDelta:
          enough && recentCtr !== null && baselineCtr !== null && baselineCtr > 0
            ? recentCtr / baselineCtr - 1
            : null,
      }
    })
    .sort((a, b) => b.impressions - a.impressions)
}

/* ---------------------------------------------------- send-time attribution */

export type SendTimeGroup = {
  source: 'ai' | 'manual'
  items: number
  impressions: number
  opens: number
  clicks: number
  conversions: number
  signups: number
  spend: number
}

export type SendTimeComparison = {
  ai: SendTimeGroup
  manual: SendTimeGroup
  /** Mean lift the scheduler predicted for the AI-placed sends in this window. */
  predictedLift: number | null
  channels: string[]
}

/**
 * PF-2, the decision-attribution view: did letting the scheduler pick the slot
 * actually beat picking it by hand?
 *
 * Only metric rows dated on or after the item's own publish date count towards
 * it — a send cannot be credited with clicks that happened before it went out.
 * Each published asset carries exactly one schedule item, so nothing is
 * double-counted across the two groups.
 */
export async function sendTimeComparison(
  workspaceId: string,
  days: RangeDays,
): Promise<SendTimeComparison> {
  const rows = await db
    .select({
      source: scheduleItems.sendTimeSource,
      items: sql<number>`count(distinct ${scheduleItems.id})::int`,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}), 0)::int`,
      opens: sql<number>`coalesce(sum(${metricFacts.opens}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricFacts.clicks}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}), 0)::int`,
      signups: sql<number>`coalesce(sum(${metricFacts.signups}), 0)::int`,
      spend: sql<number>`coalesce(sum(${metricFacts.spend}), 0)::float`,
      predictedLift: sql<number>`avg(distinct ${scheduleItems.predictedLift})::float`,
      channels: sql<string[]>`array_agg(distinct ${scheduleItems.channel}::text)`,
    })
    .from(scheduleItems)
    .innerJoin(
      metricFacts,
      and(
        eq(metricFacts.assetId, scheduleItems.assetId),
        sql`${metricFacts.day} >= ${scheduleItems.publishedAt}::date`,
        inCurrent(days),
      ),
    )
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        eq(scheduleItems.status, 'published'),
        sql`${scheduleItems.publishedAt} is not null`,
      ),
    )
    .groupBy(scheduleItems.sendTimeSource)

  const empty = (source: 'ai' | 'manual'): SendTimeGroup => ({
    source, items: 0, impressions: 0, opens: 0, clicks: 0, conversions: 0, signups: 0, spend: 0,
  })

  const pick = (source: 'ai' | 'manual'): SendTimeGroup => {
    const r = rows.find((x) => x.source === source)
    if (!r) return empty(source)
    return {
      source,
      items: r.items,
      impressions: r.impressions,
      opens: r.opens,
      clicks: r.clicks,
      conversions: r.conversions,
      signups: r.signups,
      spend: r.spend,
    }
  }

  const aiRow = rows.find((x) => x.source === 'ai')
  const channels = new Set<string>()
  for (const r of rows) for (const c of r.channels ?? []) channels.add(c)

  return {
    ai: pick('ai'),
    manual: pick('manual'),
    predictedLift: aiRow?.predictedLift ?? null,
    channels: [...channels].sort(),
  }
}
