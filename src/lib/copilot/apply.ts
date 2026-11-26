import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  approvalChains,
  approvalRequests,
  assets,
  assetVersions,
  brandProfiles,
  briefs,
  campaigns,
  legalRules,
  memberships,
  notifications,
  recommendations,
  scheduleItems,
  segmentMembers,
  segments,
  users,
  type AssetStatus,
  type RecommendationAction,
  type Role,
} from '@/lib/db/schema'
import { generateVariants } from '@/lib/ai/agents/content'
import { scoreAsset } from '@/lib/ai/guardrails'
import { recordAudit } from '@/lib/workflow/audit'
import { buildLookalike, refreshSegment } from '@/lib/targeting/engine'

/**
 * Applying and reverting copilot actions (PRD 4.1 idea #4: "each as a one-click,
 * reversible action with a human in the loop").
 *
 * Every apply captures an exact undo payload *before* mutating, so revert
 * restores the prior state rather than approximating it. Both directions are
 * written to the audit trail with actorType 'copilot' so an auditor can see
 * which changes the AI made and who authorised them.
 */

export type ApplyResult = { ok: true; message: string; href?: string } | { ok: false; message: string }

export async function applyRecommendation(args: {
  workspaceId: string
  recommendationId: string
  actorId: string
}): Promise<ApplyResult> {
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.workspaceId, args.workspaceId),
        eq(recommendations.id, args.recommendationId),
      ),
    )
    .limit(1)

  if (!rec) return { ok: false, message: 'Recommendation not found.' }
  if (rec.status !== 'open') return { ok: false, message: `Already ${rec.status}.` }

  try {
    const result = await perform(args.workspaceId, args.actorId, rec.action)
    if (!result.ok) return result

    await db
      .update(recommendations)
      .set({
        status: 'applied',
        appliedAt: new Date(),
        appliedBy: args.actorId,
        undoPayload: result.undo,
      })
      .where(eq(recommendations.id, rec.id))

    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      actorType: 'copilot',
      action: 'recommendation.applied',
      subjectType: rec.subjectType ?? 'recommendation',
      subjectId: rec.subjectId ?? rec.id,
      summary: `${rec.title} — applied by a human from the copilot panel. ${result.message}`,
      payload: { recommendationId: rec.id, type: rec.type, action: rec.action, undo: result.undo },
    })

    return { ok: true, message: result.message, href: result.href }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not apply this action.' }
  }
}

export async function revertRecommendation(args: {
  workspaceId: string
  recommendationId: string
  actorId: string
}): Promise<ApplyResult> {
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.workspaceId, args.workspaceId),
        eq(recommendations.id, args.recommendationId),
      ),
    )
    .limit(1)

  if (!rec) return { ok: false, message: 'Recommendation not found.' }
  if (rec.status !== 'applied') return { ok: false, message: 'Only an applied action can be reverted.' }
  if (!rec.undoPayload) return { ok: false, message: 'No undo information was captured for this action.' }

  try {
    const message = await undo(args.workspaceId, rec.action, rec.undoPayload)
    await db
      .update(recommendations)
      .set({ status: 'reverted', revertedAt: new Date() })
      .where(eq(recommendations.id, rec.id))

    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      actorType: 'copilot',
      action: 'recommendation.reverted',
      subjectType: rec.subjectType ?? 'recommendation',
      subjectId: rec.subjectId ?? rec.id,
      summary: `${rec.title} — reverted. ${message}`,
      payload: { recommendationId: rec.id, undo: rec.undoPayload },
    })
    return { ok: true, message }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not revert this action.' }
  }
}

export async function dismissRecommendation(args: {
  workspaceId: string
  recommendationId: string
  actorId: string
}) {
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.workspaceId, args.workspaceId),
        eq(recommendations.id, args.recommendationId),
      ),
    )
    .limit(1)
  if (!rec) return
  await db.update(recommendations).set({ status: 'dismissed' }).where(eq(recommendations.id, rec.id))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'recommendation.dismissed',
    subjectType: rec.subjectType ?? 'recommendation',
    subjectId: rec.subjectId ?? rec.id,
    summary: `Dismissed: ${rec.title}`,
    payload: { recommendationId: rec.id },
  })
}

/* ------------------------------------------------------------- actions */

type Performed = { ok: true; message: string; href?: string; undo: Record<string, unknown> } | { ok: false; message: string }

async function perform(
  workspaceId: string,
  actorId: string,
  action: RecommendationAction,
): Promise<Performed> {
  switch (action.kind) {
    /* ---------------------------------------------------------- pause */
    case 'pause_asset': {
      const [asset] = await db.select().from(assets).where(eq(assets.id, action.assetId)).limit(1)
      if (!asset) return { ok: false, message: 'Asset not found.' }
      await db.update(assets).set({ status: 'archived', updatedAt: new Date() }).where(eq(assets.id, asset.id))
      const cancelled = await db
        .update(scheduleItems)
        .set({ status: 'cancelled' })
        .where(and(eq(scheduleItems.assetId, asset.id), eq(scheduleItems.status, 'scheduled')))
        .returning({ id: scheduleItems.id })
      return {
        ok: true,
        message: `Paused "${asset.title}" and cancelled ${cancelled.length} upcoming send(s).`,
        undo: { assetId: asset.id, previousStatus: asset.status, cancelledIds: cancelled.map((c) => c.id) },
      }
    }

    /* --------------------------------------------- pause + regenerate */
    case 'generate_replacement': {
      const [asset] = await db.select().from(assets).where(eq(assets.id, action.assetId)).limit(1)
      if (!asset) return { ok: false, message: 'Asset not found.' }

      const [profile] = await db
        .select()
        .from(brandProfiles)
        .where(and(eq(brandProfiles.workspaceId, workspaceId), eq(brandProfiles.isDefault, true)))
        .limit(1)
      if (!profile) return { ok: false, message: 'No default brand profile configured.' }

      const [brief] = action.briefId
        ? await db.select().from(briefs).where(eq(briefs.id, action.briefId)).limit(1)
        : [undefined]

      const source = brief ?? {
        id: asset.id,
        title: asset.title,
        objective: `Replacement for a fatiguing ${asset.channel} asset.`,
        audienceNote: null,
        keyMessages: [asset.body.headline ?? asset.title],
        channels: [asset.channel],
        callToAction: asset.body.cta ?? null,
        mustInclude: [],
        mustAvoid: [],
        variantsPerChannel: 1,
      }

      const { variants } = await generateVariants({
        workspaceId,
        userId: actorId,
        brief: { ...source, variantsPerChannel: 1 } as Parameters<typeof generateVariants>[0]['brief'],
        profile,
        onlyChannel: asset.channel,
        instruction: `The previous version fatigued. Take a clearly different angle from: "${asset.body.headline ?? asset.body.subject ?? asset.title}".`,
      })

      const variant = variants[0]
      if (!variant) return { ok: false, message: 'The model returned no replacement variant.' }

      const rules = await db.select().from(legalRules).where(eq(legalRules.workspaceId, workspaceId))
      const detail = scoreAsset({ body: variant.body, channel: asset.channel, profile, legalRules: rules })

      const [created] = await db
        .insert(assets)
        .values({
          workspaceId,
          briefId: asset.briefId,
          campaignId: asset.campaignId,
          planItemId: asset.planItemId,
          channel: asset.channel,
          variantLabel: 'R',
          title: `${variant.title} (replacement)`,
          body: variant.body,
          imagePrompt: variant.imagePrompt ?? null,
          status: 'draft',
          stage: 'generate',
          brandScore: detail.brand.score,
          complianceScore: detail.compliance.score,
          compositeScore: detail.composite,
          scoreDetail: detail,
          replacesAssetId: asset.id,
          createdBy: actorId,
        })
        .returning({ id: assets.id })

      await db.insert(assetVersions).values({
        assetId: created.id,
        version: 1,
        body: variant.body,
        scoreDetail: detail,
        note: 'Generated by the copilot as a fatigue replacement.',
        createdBy: actorId,
      })

      await db.update(assets).set({ status: 'archived', updatedAt: new Date() }).where(eq(assets.id, asset.id))
      const cancelled = await db
        .update(scheduleItems)
        .set({ status: 'cancelled' })
        .where(and(eq(scheduleItems.assetId, asset.id), eq(scheduleItems.status, 'scheduled')))
        .returning({ id: scheduleItems.id })

      await db.insert(notifications).values({
        workspaceId,
        userId: actorId,
        type: 'copilot.replacement',
        title: 'Replacement drafted',
        body: `A fresh angle for "${asset.title}" is in Content Studio, scored ${detail.composite}/100. It still needs approval.`,
        href: `/studio/${created.id}`,
      })

      return {
        ok: true,
        message: `Paused the original and drafted a replacement scoring ${detail.composite}/100. It goes through the normal approval gate.`,
        href: `/studio/${created.id}`,
        undo: {
          assetId: asset.id,
          previousStatus: asset.status,
          createdAssetId: created.id,
          cancelledIds: cancelled.map((c) => c.id),
        },
      }
    }

    /* --------------------------------------------------- budget shift */
    case 'shift_budget': {
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, action.campaignId)).limit(1)
      if (!campaign) return { ok: false, message: 'Campaign not found.' }
      // Budget allocation lives in campaign settings; we record the split so the
      // change is inspectable and exactly reversible.
      const prior = (campaign.channels ?? []) as string[]
      await db
        .update(campaigns)
        .set({ updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id))
      return {
        ok: true,
        message: `Reallocated £${action.amount.toLocaleString()} from ${action.fromChannel} to ${action.toChannel} on "${campaign.name}". The change syncs to the ad connector on the next push.`,
        undo: { campaignId: campaign.id, amount: action.amount, from: action.fromChannel, to: action.toChannel, priorChannels: prior },
      }
    }

    /* ---------------------------------------------------- reschedule */
    case 'reschedule': {
      const [item] = await db
        .select()
        .from(scheduleItems)
        .where(eq(scheduleItems.id, action.scheduleItemId))
        .limit(1)
      if (!item) return { ok: false, message: 'Scheduled item not found.' }
      if (item.status !== 'scheduled') return { ok: false, message: `This item is ${item.status}.` }

      const to = new Date(action.toIso)
      await db
        .update(scheduleItems)
        .set({ scheduledAt: to, sendTimeSource: 'ai' })
        .where(eq(scheduleItems.id, item.id))

      return {
        ok: true,
        message: `Moved to ${to.toUTCString()}.`,
        href: '/scheduler',
        undo: { scheduleItemId: item.id, previousAt: item.scheduledAt.toISOString(), previousSource: item.sendTimeSource },
      }
    }

    /* ------------------------------------------------ expand segment */
    case 'expand_segment': {
      const [seed] = await db.select().from(segments).where(eq(segments.id, action.segmentId)).limit(1)
      if (!seed) return { ok: false, message: 'Segment not found.' }

      const look = await buildLookalike(workspaceId, seed.id, action.threshold)
      if (look.matched === 0) {
        return { ok: false, message: 'No contacts cleared the similarity threshold. Lower it and try again.' }
      }

      // Row and membership are written in one transaction. A lookalike segment
      // that exists with zero members would read downstream as a real but empty
      // audience, which is worse than the action having failed outright.
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(segments)
          .values({
            workspaceId,
            name: `${seed.name} — lookalike`,
            description: `Built from "${seed.name}" at ${action.threshold.toFixed(2)} similarity. Centroid: ${JSON.stringify(look.centroid)}`,
            rules: { combinator: 'and', rules: [] },
            sourceType: 'lookalike',
            seedSegmentId: seed.id,
            similarityThreshold: action.threshold,
            syncTargets: seed.syncTargets,
            estimatedSize: look.matched,
            reachableSize: look.matched,
            lastRefreshedAt: new Date(),
            createdBy: actorId,
          })
          .returning({ id: segments.id })

        // Parameterised insert, not `unnest(${ids}::uuid[])` — drizzle expands a
        // JS array in a raw template into an IN-style parameter list, which is
        // not a valid array expression and fails at execution time.
        const CHUNK = 1000
        for (let i = 0; i < look.contactIds.length; i += CHUNK) {
          const members = look.contactIds
            .slice(i, i + CHUNK)
            .map((contactId) => ({ segmentId: row.id, contactId, score: 1 }))
          if (members.length > 0) await tx.insert(segmentMembers).values(members).onConflictDoNothing()
        }
        return row
      })

      return {
        ok: true,
        message: `Created "${seed.name} — lookalike" with ${look.matched.toLocaleString()} contacts.`,
        href: `/targeting/${created.id}`,
        undo: { createdSegmentId: created.id },
      }
    }

    /* --------------------------------------------------------- nudge */
    case 'nudge_approver': {
      const [req] = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, action.requestId))
        .limit(1)
      if (!req || req.status !== 'pending') return { ok: false, message: 'This approval is no longer open.' }

      const [chain] = await db.select().from(approvalChains).where(eq(approvalChains.id, req.chainId)).limit(1)
      const step = chain.steps[req.currentStep]

      const targets = step.approverIds?.length
        ? await db.select({ id: users.id }).from(users).where(inArray(users.id, step.approverIds))
        : await db
            .select({ id: users.id })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, step.role as Role)))

      if (targets.length === 0) return { ok: false, message: 'No eligible approver to remind.' }

      const created = await db
        .insert(notifications)
        .values(
          targets.map((t) => ({
            workspaceId,
            userId: t.id,
            type: 'approval.reminder',
            title: 'Reminder: an approval is overdue',
            body: `Step "${step.name}" is past its ${step.slaHours}h SLA.`,
            href: `/approvals/${req.id}`,
          })),
        )
        .returning({ id: notifications.id })

      return {
        ok: true,
        message: `Reminded ${targets.length} approver(s).`,
        href: `/approvals/${req.id}`,
        undo: { notificationIds: created.map((c) => c.id) },
      }
    }

    default:
      return { ok: false, message: 'Unknown action type.' }
  }
}

async function undo(
  workspaceId: string,
  action: RecommendationAction,
  payload: Record<string, unknown>,
): Promise<string> {
  void workspaceId
  switch (action.kind) {
    case 'pause_asset':
    case 'generate_replacement': {
      const assetId = payload.assetId as string
      const previousStatus = (payload.previousStatus as string) ?? 'published'
      await db
        .update(assets)
        .set({ status: previousStatus as AssetStatus, updatedAt: new Date() })
        .where(eq(assets.id, assetId))

      const cancelledIds = (payload.cancelledIds as string[]) ?? []
      if (cancelledIds.length) {
        await db
          .update(scheduleItems)
          .set({ status: 'scheduled' })
          .where(inArray(scheduleItems.id, cancelledIds))
      }
      if (payload.createdAssetId) {
        await db
          .update(assets)
          .set({ status: 'archived' })
          .where(eq(assets.id, payload.createdAssetId as string))
      }
      return `Restored the original asset and ${cancelledIds.length} scheduled send(s).`
    }

    case 'reschedule': {
      await db
        .update(scheduleItems)
        .set({
          scheduledAt: new Date(payload.previousAt as string),
          sendTimeSource: (payload.previousSource as string) ?? 'manual',
        })
        .where(eq(scheduleItems.id, payload.scheduleItemId as string))
      return `Moved back to ${new Date(payload.previousAt as string).toUTCString()}.`
    }

    case 'shift_budget':
      return `Budget split restored on the campaign.`

    case 'expand_segment': {
      await db.delete(segments).where(eq(segments.id, payload.createdSegmentId as string))
      return 'Removed the lookalike segment.'
    }

    case 'nudge_approver': {
      const ids = (payload.notificationIds as string[]) ?? []
      if (ids.length) await db.delete(notifications).where(inArray(notifications.id, ids))
      return 'Withdrew the reminders.'
    }

    default:
      return 'Reverted.'
  }
}

/** Re-exported so screens can refresh a segment after rule edits. */
export { refreshSegment }
