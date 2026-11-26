import 'server-only'
import { and, eq, notInArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { adCampaigns, assets, budgetLines, budgetPlans, serpTwinActions, videoGenerations } from '@/lib/db/schema'

/**
 * What the approval engine needs to know about the thing being approved.
 *
 * The engine was built for organic assets. Paid campaigns need exactly the same
 * governance — arguably more, since they spend money — but they are a different
 * table with a different lifecycle. Rather than fork the engine or bolt paid
 * onto the assets table, the engine talks to this narrow interface and each
 * subject type supplies an adapter.
 *
 * The alternative, copying `decide()` for campaigns, would mean two
 * implementations of the rule "nothing publishes without a completed chain",
 * and the second one would drift.
 */

export type ApprovalSubjectType = 'asset' | 'ad_campaign' | 'video' | 'search_action' | 'budget_plan'

export type ApprovalSubject = {
  type: ApprovalSubjectType
  id: string
  title: string
  /** Snapshotted on the request; a later edit invalidates the approval. */
  version: number
  /** Used for chain matching. Paid campaigns report their provider. */
  channel: string | null
  campaignId: string | null
  status: string
  /** Money at stake, so a spend-threshold chain can match. Zero for organic. */
  spend: number
  /** A blocking reason that should stop submission outright, or null. */
  submitBlocker: string | null
  /** Where a reviewer goes to look at it. */
  href: string
  /** Where the requester goes once it is approved. */
  approvedHref: string
  /** What the notification says once it is approved. */
  approvedNote: string
  /** Noun used in messages: "asset", "campaign". */
  noun: string
}

export interface SubjectAdapter {
  load(workspaceId: string, id: string): Promise<ApprovalSubject | null>
  setStatus(
    id: string,
    status: 'in_review' | 'changes_requested' | 'approved',
    at: Date,
  ): Promise<void>
}

/* ---------------------------------------------------------------- assets */

const assetAdapter: SubjectAdapter = {
  async load(workspaceId, id) {
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, id)))
      .limit(1)
    if (!row) return null

    const blocker = row.scoreDetail?.compliance.findings.find((f) => f.severity === 'high')
    return {
      type: 'asset',
      id: row.id,
      title: row.title,
      version: row.version,
      channel: row.channel,
      campaignId: row.campaignId,
      status: row.status,
      spend: 0,
      submitBlocker: blocker ? `${blocker.ruleName} — ${blocker.message}` : null,
      href: `/studio/${row.id}`,
      approvedHref: `/scheduler?asset=${row.id}`,
      approvedNote: 'It can now be scheduled.',
      noun: 'asset',
    }
  },
  async setStatus(id, status, at) {
    const stage = status === 'approved' ? 'approve' : status === 'in_review' ? 'review' : 'generate'
    await db.update(assets).set({ status, stage, updatedAt: at }).where(eq(assets.id, id))
  },
}

/* --------------------------------------------------------- ad campaigns */

const adCampaignAdapter: SubjectAdapter = {
  async load(workspaceId, id) {
    const [row] = await db
      .select()
      .from(adCampaigns)
      .where(and(eq(adCampaigns.workspaceId, workspaceId), eq(adCampaigns.id, id)))
      .limit(1)
    if (!row) return null

    /**
     * Spend is expressed as the campaign's monthly ceiling, not its daily
     * budget. A spend-threshold approval chain set at £1,000 should catch a
     * £40/day campaign — which will spend around £1,200 a month — and it would
     * not if we reported £40 here.
     */
    const monthlySpend = (row.dailyBudgetMicros / 1_000_000) * 30.4

    return {
      type: 'ad_campaign',
      id: row.id,
      title: row.name,
      version: row.version,
      channel: row.provider,
      campaignId: row.campaignId,
      status: row.status,
      spend: monthlySpend,
      submitBlocker: blockerFor(row),
      href: `/ads/${row.id}`,
      approvedHref: `/ads/${row.id}`,
      approvedNote: 'It can now be pushed to Google. It will arrive paused until someone turns it on.',
      noun: 'campaign',
    }
  },
  async setStatus(id, status, at) {
    await db.update(adCampaigns).set({ status, updatedAt: at }).where(eq(adCampaigns.id, id))
  },
}

function blockerFor(row: typeof adCampaigns.$inferSelect): string | null {
  if (!row.structure || row.structure.adGroups.length === 0) {
    return 'The campaign has no ads yet. Generate the plan before submitting it.'
  }
  if (!row.finalUrl) {
    return 'There is no landing page set, so Google would have nowhere to send the clicks.'
  }
  if (row.dailyBudgetMicros <= 0) {
    return 'The daily budget is zero.'
  }
  if (row.geoTargets.length === 0) {
    return 'No locations are selected, so the ads would show worldwide.'
  }
  return null
}

/* ---------------------------------------------------------------- video */

/**
 * Generated video reaches the reviewer through the same engine, for the same
 * reason paid search does: the alternative is a second implementation of
 * "nothing publishes without a completed chain", and the second one drifts.
 *
 * The spend it reports is the clip's own cost, which is small — but the
 * blocker below is where the real governance sits. A clip whose mechanical
 * checks failed cannot be submitted at all: a reviewer's time should not be
 * spent on footage the platform already knows will be rejected at upload.
 */
const videoAdapter: SubjectAdapter = {
  async load(workspaceId, id) {
    const [row] = await db
      .select()
      .from(videoGenerations)
      .where(and(eq(videoGenerations.workspaceId, workspaceId), eq(videoGenerations.id, id)))
      .limit(1)
    if (!row) return null

    return {
      type: 'video',
      id: row.id,
      title: row.title,
      version: row.version,
      channel: row.channel,
      campaignId: row.campaignId,
      status: row.status,
      spend: (row.actualCostCents ?? row.estimatedCostCents) / 100,
      submitBlocker: videoBlockerFor(row),
      href: `/studio/video/${row.id}`,
      approvedHref: `/studio/video/${row.id}`,
      approvedNote: 'It can now be scheduled or downloaded.',
      noun: 'clip',
    }
  },
  async setStatus(id, status, at) {
    const stage = status === 'approved' ? 'approve' : status === 'in_review' ? 'review' : 'generate'
    await db.update(videoGenerations).set({ status, stage, updatedAt: at }).where(eq(videoGenerations.id, id))
  },
}

function videoBlockerFor(row: typeof videoGenerations.$inferSelect): string | null {
  if (row.status === 'dead_letter') {
    return `This generation failed and produced no clip. ${row.lastError ?? ''}`.trim()
  }
  if (!row.storageKey || row.status === 'queued' || row.status === 'submitted' || row.status === 'generating' || row.status === 'storing') {
    return 'The clip is still being generated.'
  }
  const blocking = row.mediaCheck?.findings.filter((f) => f.severity === 'high') ?? []
  if (blocking.length > 0) {
    // Naming the first one is enough to act on; the review screen lists them all.
    return `It would be rejected at upload — ${blocking[0].message}`
  }
  return null
}

/* ------------------------------------------------------ PPC + SEO actions */

/**
 * A SERP Twin recommendation — new negatives, a headline swap, a page title,
 * a pause test — goes through the same engine as everything else that touches
 * money or a live surface.
 *
 * The spend it reports is the recommendation's monthly impact: the money at
 * stake either way. A spend-threshold chain at £1,000 should catch a pause
 * test on £2,400 of monthly spend, and it would not if this reported zero.
 * Paid changes report the google_ads channel so paid chains match them; page
 * changes report web.
 */
const searchActionAdapter: SubjectAdapter = {
  async load(workspaceId, id) {
    const [row] = await db
      .select()
      .from(serpTwinActions)
      .where(and(eq(serpTwinActions.workspaceId, workspaceId), eq(serpTwinActions.id, id)))
      .limit(1)
    if (!row) return null

    const gated = row.recommendation.actions.filter((a) => a.requiresApproval)
    const touchesPage = gated.some((a) => a.kind === 'update_page_meta')
    return {
      type: 'search_action',
      id: row.id,
      title: row.title,
      version: row.version,
      channel: touchesPage ? 'web' : 'google_ads',
      campaignId: null,
      status: row.status,
      spend: Math.abs(row.monthlyImpact),
      submitBlocker:
        gated.length === 0
          ? 'This recommendation changes nothing live, so it does not need approval.'
          : row.status === 'applied'
            ? 'This change has already been applied. Revert it first to change it.'
            : null,
      href: `/search/actions/${row.id}`,
      approvedHref: `/search/actions/${row.id}`,
      approvedNote: 'It can now be applied by an owner or marketing ops.',
      noun: 'search change',
    }
  },
  async setStatus(id, status, at) {
    await db.update(serpTwinActions).set({ status, updatedAt: at }).where(eq(serpTwinActions.id, id))
  },
}

/* ----------------------------------------------------------- budget plans */

/**
 * A budget plan commits money across every channel at once, so it goes
 * through the same engine as a campaign. The spend it reports is the plan's
 * monthly equivalent: a £30,000 quarter is £10,000 a month, and a
 * spend-threshold chain set at £2,500 should catch it.
 *
 * It reports the paid-media channel so "paid media" chains match it. A plan
 * whose lines do not add up to its total cannot be submitted: a reviewer
 * should not be asked to approve arithmetic that is wrong.
 */
const budgetPlanAdapter: SubjectAdapter = {
  async load(workspaceId, id) {
    const [row] = await db
      .select()
      .from(budgetPlans)
      .where(and(eq(budgetPlans.workspaceId, workspaceId), eq(budgetPlans.id, id)))
      .limit(1)
    if (!row) return null
    const lines = await db.select().from(budgetLines).where(eq(budgetLines.planId, id))
    const days = Math.max(1, (Date.parse(String(row.periodEnd)) - Date.parse(String(row.periodStart))) / 86_400_000 + 1)
    const monthly = (row.totalPence / 100) * (30.4 / days)
    const sum = lines.reduce((a, l) => a + l.plannedPence, 0)
    const blocker =
      lines.length === 0
        ? 'The plan has no lines.'
        : sum !== row.totalPence
          ? `The lines add up to £${(sum / 100).toFixed(2)}, not the £${(row.totalPence / 100).toFixed(2)} total.`
          : row.status === 'active' || row.status === 'superseded' || row.status === 'closed'
            ? 'This plan is no longer a draft. Revise it to propose changes.'
            : null
    return {
      type: 'budget_plan',
      id: row.id,
      title: row.name,
      version: row.version,
      channel: 'google_ads',
      campaignId: null,
      status: row.status,
      spend: monthly,
      submitBlocker: blocker,
      href: `/budget/plans/${row.id}`,
      approvedHref: `/budget/plans/${row.id}`,
      approvedNote: 'It can now be made live by an owner or marketing ops.',
      noun: 'budget plan',
    }
  },
  async setStatus(id, status, at) {
    await db
      .update(budgetPlans)
      .set({ status, updatedAt: at, ...(status === 'approved' ? { approvedAt: at } : {}) })
      // A plan already live, replaced or closed is never moved back into review by a stale request.
      .where(and(eq(budgetPlans.id, id), notInArray(budgetPlans.status, ['active', 'superseded', 'closed'])))
  },
}

/* -------------------------------------------------------------- registry */

const ADAPTERS: Record<string, SubjectAdapter> = {
  asset: assetAdapter,
  ad_campaign: adCampaignAdapter,
  video: videoAdapter,
  search_action: searchActionAdapter,
  budget_plan: budgetPlanAdapter,
}

export function adapterFor(subjectType: string): SubjectAdapter {
  const adapter = ADAPTERS[subjectType]
  if (!adapter) throw new Error(`No approval adapter registered for subject type "${subjectType}".`)
  return adapter
}

export function loadSubject(
  subjectType: string,
  workspaceId: string,
  id: string,
): Promise<ApprovalSubject | null> {
  return adapterFor(subjectType).load(workspaceId, id)
}
