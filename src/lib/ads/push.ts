import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { adAccounts, adCampaigns, adPushLog, type AdCampaign } from '@/lib/db/schema'
import { hasGoogleAds } from '@/lib/env'
import { assertPushable, GateError } from '@/lib/workflow/approvals'
import { recordAudit } from '@/lib/workflow/audit'
import { objectiveDef } from './objectives'
import { validateCampaign } from './validate'
import {
  GoogleAdsError,
  mutate,
  setCampaignStatus,
  type CallContext,
  type MutateResponse,
} from './google/client'
import { buildCampaignOperations, readMutateResponse, todayInTimeZone, type BuildInput } from './google/build'
import { simulateMutate, simulateStatusChange } from './google/simulator'

/**
 * Getting a campaign from this platform into Google.
 *
 * The order of operations is the whole design, and it is deliberate:
 *
 *   1. The approval gate. Nothing proceeds without a completed chain on the
 *      exact version being pushed.
 *   2. Our own validator, which knows Google's rules and speaks English.
 *   3. Build the payload.
 *   4. Ask Google to validate the payload and create nothing.
 *   5. Only then, create — as a single atomic mutate, PAUSED.
 *
 * Steps 4 and 5 are separate on purpose. A campaign that half-exists in a
 * client's account is worse than one that failed cleanly, and the dry run turns
 * almost every failure into one that happened before anything was written.
 *
 * Nothing here ever enables a campaign. Going live is a separate action, taken
 * by a person who has been shown what it will cost.
 */

export type PushOutcome = {
  ok: boolean
  simulated: boolean
  message: string
  campaignResourceName?: string
  requestId?: string
  /** Present when the push failed for reasons the user can act on. */
  problems?: { where: string; message: string; fix: string }[]
}

/* ------------------------------------------------------------------ context */

async function contextFor(campaign: AdCampaign): Promise<{ ctx: CallContext; timeZone: string }> {
  if (!campaign.accountId) {
    throw new GateError(
      'This campaign is not linked to a Google Ads account. Connect one in Settings, then choose it on the campaign.',
    )
  }
  const [account] = await db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.workspaceId, campaign.workspaceId), eq(adAccounts.id, campaign.accountId)))
    .limit(1)
  if (!account) throw new GateError('The Google Ads account this campaign points at no longer exists.')

  return {
    ctx: {
      customerId: account.customerId,
      loginCustomerId: account.managerCustomerId,
    },
    timeZone: account.timeZone ?? 'Europe/London',
  }
}

export function buildInputFor(campaign: AdCampaign, timeZone: string): BuildInput {
  const objective = objectiveDef(campaign.objective)
  const today = todayInTimeZone(timeZone)
  // Google rejects a start date in the past, and a saved draft can easily be
  // approved days after it was written.
  const startDate =
    campaign.startDate && campaign.startDate > today ? campaign.startDate : today

  return {
    customerId: '', // filled by the caller, which holds the account
    campaignName: campaign.name,
    channelType: (campaign.channelType as BuildInput['channelType']) ?? objective.channelType,
    biddingStrategy: (campaign.biddingStrategy as BuildInput['biddingStrategy']) ?? objective.biddingStrategy,
    dailyBudgetMicros: campaign.dailyBudgetMicros,
    targetCpaMicros: campaign.targetCpaMicros,
    targetRoas: campaign.targetRoas,
    startDate,
    endDate: campaign.endDate,
    geoTargets: campaign.geoTargets.map((g) => g.criterionId),
    languages: campaign.languages,
    finalUrl: campaign.finalUrl ?? '',
    conversionAction: campaign.conversionAction,
    structure: campaign.structure ?? { adGroups: [], negativeKeywords: [], sitelinks: [], callouts: [], rationale: '' },
    status: 'PAUSED',
  }
}

/* ---------------------------------------------------------------- dry run */

/**
 * Everything the real push does, minus the write. Exposed on its own because a
 * reviewer should be able to press "check with Google" before approving, and
 * because the push itself calls it first.
 */
export async function dryRun(args: {
  workspaceId: string
  adCampaignId: string
  actorId: string
}): Promise<PushOutcome> {
  const [campaign] = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.workspaceId, args.workspaceId), eq(adCampaigns.id, args.adCampaignId)))
    .limit(1)
  if (!campaign) throw new GateError('Campaign not found.')

  const report = validateCampaign({
    name: campaign.name,
    finalUrl: campaign.finalUrl ?? '',
    dailyBudget: campaign.dailyBudgetMicros / 1_000_000,
    currencyCode: campaign.currencyCode,
    geoTargets: campaign.geoTargets.map((g) => g.criterionId),
    languages: campaign.languages,
    structure: campaign.structure ?? { adGroups: [], negativeKeywords: [], sitelinks: [], callouts: [], rationale: '' },
    suggestedMinDailyBudget: objectiveDef(campaign.objective).suggestedMinDailyBudget,
    conversionAction: campaign.conversionAction,
    objectiveKey: campaign.objective,
  })

  if (!report.ok) {
    return {
      ok: false,
      simulated: true,
      message: `${report.errors.length} thing${report.errors.length === 1 ? '' : 's'} would stop Google accepting this.`,
      problems: report.errors.map((e) => ({ where: e.where, message: e.message, fix: e.fix })),
    }
  }

  const { ctx, timeZone } = await contextFor(campaign)
  const operations = buildCampaignOperations({
    ...buildInputFor(campaign, timeZone),
    customerId: ctx.customerId,
  })

  return execute({
    campaign,
    ctx,
    operations,
    action: 'validate',
    actorId: args.actorId,
    validateOnly: true,
  })
}

/* ------------------------------------------------------------------- push */

export async function pushCampaign(args: {
  workspaceId: string
  adCampaignId: string
  actorId: string
}): Promise<PushOutcome> {
  // 1. Governance first, before anything is built or sent.
  const campaign = await assertPushable(args.workspaceId, args.adCampaignId)

  // 2. Our own rules.
  const check = await dryRun(args)
  if (!check.ok) return check

  const { ctx, timeZone } = await contextFor(campaign)
  const operations = buildCampaignOperations({
    ...buildInputFor(campaign, timeZone),
    customerId: ctx.customerId,
  })

  await db
    .update(adCampaigns)
    .set({ status: 'publishing', updatedAt: new Date() })
    .where(eq(adCampaigns.id, campaign.id))

  const outcome = await execute({
    campaign,
    ctx,
    operations,
    action: 'create',
    actorId: args.actorId,
    validateOnly: false,
  })

  if (!outcome.ok) {
    await db
      .update(adCampaigns)
      .set({ status: 'failed', lastError: outcome.message, updatedAt: new Date() })
      .where(eq(adCampaigns.id, campaign.id))
    return outcome
  }

  return outcome
}

/* ---------------------------------------------------------------- go live */

/**
 * The only action in this platform that starts spending money, and the only one
 * that is never automatic. The caller is responsible for having shown the user
 * the daily and monthly figures first; this records that they did.
 */
export async function setLive(args: {
  workspaceId: string
  adCampaignId: string
  actorId: string
  live: boolean
}): Promise<PushOutcome> {
  const [campaign] = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.workspaceId, args.workspaceId), eq(adCampaigns.id, args.adCampaignId)))
    .limit(1)
  if (!campaign) throw new GateError('Campaign not found.')
  if (!campaign.externalCampaignId) {
    throw new GateError('This campaign has not been pushed to Google yet, so there is nothing to turn on.')
  }
  if (args.live && campaign.status !== 'paused' && campaign.status !== 'approved') {
    if (campaign.status === 'live') return { ok: true, simulated: false, message: 'Already running.' }
  }

  const { ctx } = await contextFor(campaign)
  const status = args.live ? 'ENABLED' : 'PAUSED'
  const simulated = !hasGoogleAds()
  const now = new Date()

  try {
    const result = simulated
      ? simulateStatusChange(campaign.externalCampaignId, status)
      : await setCampaignStatus(campaign.externalCampaignId, status, ctx)

    await db
      .update(adCampaigns)
      .set({
        status: args.live ? 'live' : 'paused',
        wentLiveAt: args.live ? (campaign.wentLiveAt ?? now) : campaign.wentLiveAt,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(adCampaigns.id, campaign.id))

    await db.insert(adPushLog).values({
      workspaceId: campaign.workspaceId,
      adCampaignId: campaign.id,
      action: args.live ? 'enable' : 'pause',
      ok: true,
      simulated,
      requestId: result.requestId ?? null,
      operationCount: 1,
      request: { resourceName: campaign.externalCampaignId, status },
      response: result.data as Record<string, unknown>,
      actorId: args.actorId,
    })

    const monthly = Math.round((campaign.dailyBudgetMicros / 1_000_000) * 30.4)
    await recordAudit({
      workspaceId: campaign.workspaceId,
      actorId: args.actorId,
      action: args.live ? 'ads.enabled' : 'ads.paused',
      subjectType: 'ad_campaign',
      subjectId: campaign.id,
      summary: args.live
        ? `"${campaign.name}" was turned on. It can now spend up to ${campaign.currencyCode} ${monthly} a month.`
        : `"${campaign.name}" was paused. It will stop spending.`,
      payload: { simulated, monthlyCeiling: monthly, currency: campaign.currencyCode },
    })

    return {
      ok: true,
      simulated,
      message: args.live
        ? `Live. It will start showing within a few hours, once Google has reviewed the ads.`
        : 'Paused. Spending stops immediately.',
      requestId: result.requestId,
    }
  } catch (error) {
    return failure(error, campaign, args.actorId, args.live ? 'enable' : 'pause', simulated, 1, {
      resourceName: campaign.externalCampaignId,
      status,
    })
  }
}

/* ----------------------------------------------------------------- engine */

async function execute(args: {
  campaign: AdCampaign
  ctx: CallContext
  operations: Record<string, unknown>[]
  action: 'validate' | 'create'
  actorId: string
  validateOnly: boolean
}): Promise<PushOutcome> {
  const { campaign, ctx, operations, validateOnly } = args
  const simulated = !hasGoogleAds()
  const now = new Date()

  try {
    const result = simulated
      ? simulateMutate(operations, {
          customerId: ctx.customerId,
          validateOnly,
          seed: campaign.id,
        })
      : await mutate(operations, ctx, { validateOnly })

    if (validateOnly) {
      await db.insert(adPushLog).values({
        workspaceId: campaign.workspaceId,
        adCampaignId: campaign.id,
        action: 'validate',
        ok: true,
        simulated,
        requestId: result.requestId ?? null,
        operationCount: operations.length,
        request: { operations },
        response: result.data as Record<string, unknown>,
        actorId: args.actorId,
      })
      return {
        ok: true,
        simulated,
        requestId: result.requestId,
        message: simulated
          ? `Checked against Google's rules — ${operations.length} operations, no problems. This is the built-in checker; the campaign has not been sent to Google because the account is not connected yet.`
          : `Google checked all ${operations.length} operations and found no problems. Nothing was created.`,
      }
    }

    const created = readMutateResponse(result.data as MutateResponse)

    await db
      .update(adCampaigns)
      .set({
        status: 'paused',
        externalCampaignId: created.campaign ?? null,
        externalBudgetId: created.budget ?? null,
        externalResourceNames: {
          campaign: created.campaign ?? '',
          budget: created.budget ?? '',
          adGroups: created.adGroups.join(','),
          ads: created.ads.join(','),
        },
        pushedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(adCampaigns.id, campaign.id))

    await db.insert(adPushLog).values({
      workspaceId: campaign.workspaceId,
      adCampaignId: campaign.id,
      action: 'create',
      ok: true,
      simulated,
      requestId: result.requestId ?? null,
      operationCount: operations.length,
      request: { operations },
      response: result.data as Record<string, unknown>,
      actorId: args.actorId,
    })

    await recordAudit({
      workspaceId: campaign.workspaceId,
      actorId: args.actorId,
      action: 'ads.pushed',
      subjectType: 'ad_campaign',
      subjectId: campaign.id,
      summary: simulated
        ? `"${campaign.name}" was built and validated but not sent — Google Ads is not connected, so this was a simulated push.`
        : `"${campaign.name}" was created in Google Ads, paused. ${created.adGroups.length} ad groups, ${created.ads.length} ads.`,
      payload: {
        simulated,
        operationCount: operations.length,
        campaignResourceName: created.campaign,
        requestId: result.requestId,
      },
    })

    return {
      ok: true,
      simulated,
      campaignResourceName: created.campaign,
      requestId: result.requestId,
      message: simulated
        ? 'Built and checked. Google Ads is not connected yet, so nothing was sent — connect an account and push again to create it for real.'
        : 'Created in Google Ads, paused. Nothing is spending yet. Review it and turn it on when you are ready.',
    }
  } catch (error) {
    return failure(error, campaign, args.actorId, args.action, simulated, operations.length, {
      operations,
    })
  }
}

async function failure(
  error: unknown,
  campaign: AdCampaign,
  actorId: string,
  action: string,
  simulated: boolean,
  operationCount: number,
  request: Record<string, unknown>,
): Promise<PushOutcome> {
  const isGoogle = error instanceof GoogleAdsError
  const message = error instanceof Error ? error.message : 'Something went wrong talking to Google.'

  await db.insert(adPushLog).values({
    workspaceId: campaign.workspaceId,
    adCampaignId: campaign.id,
    action,
    ok: false,
    simulated,
    requestId: isGoogle ? (error.detail.requestId ?? null) : null,
    operationCount,
    request,
    response: isGoogle ? ({ errors: error.detail.errors, status: error.detail.status } as Record<string, unknown>) : null,
    error: message,
    actorId,
  })

  await recordAudit({
    workspaceId: campaign.workspaceId,
    actorId,
    action: 'ads.push_failed',
    subjectType: 'ad_campaign',
    subjectId: campaign.id,
    summary: `Push failed: ${message}`,
    payload: { simulated, action, errors: isGoogle ? error.detail.errors : undefined },
  })

  return {
    ok: false,
    simulated,
    message,
    requestId: isGoogle ? error.detail.requestId : undefined,
    problems: isGoogle
      ? error.detail.errors.map((e) => ({
          where: e.field ?? 'Google',
          message: e.message,
          fix: isGoogle && error.detail.retryable ? 'This one is usually temporary — try again in a minute.' : 'Fix this and push again.',
        }))
      : undefined,
  }
}

/* ---------------------------------------------------------------- history */

export async function pushHistory(workspaceId: string, adCampaignId: string, limit = 20) {
  return db
    .select()
    .from(adPushLog)
    .where(and(eq(adPushLog.workspaceId, workspaceId), eq(adPushLog.adCampaignId, adCampaignId)))
    .orderBy(desc(adPushLog.createdAt))
    .limit(limit)
}
