'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { adAccounts, adCampaigns, brandProfiles, type AdCampaignStructure } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { generateAdCampaign } from '@/lib/ai/agents/ads'
import { competitorContextFor } from '@/lib/competitors/service'
import { objectiveDef, toMicros, GEO_PRESETS } from '@/lib/ads/objectives'
import { validateCampaign, autoRepair } from '@/lib/ads/validate'
import { dryRun, pushCampaign, setLive } from '@/lib/ads/push'
import { describeCustomer, normaliseCustomerId, GoogleAdsError } from '@/lib/ads/google/client'
import { hasGoogleAds } from '@/lib/env'
import { submitForReview, GateError } from '@/lib/workflow/approvals'
import { recordAudit } from '@/lib/workflow/audit'
import type { ActionResult } from './content'

/**
 * Server actions for paid advertising.
 *
 * Two rules run through all of them. Every action that could spend money checks
 * the permission first and the approval gate second, and every failure comes
 * back as a message someone who does not work in marketing can act on — never a
 * raw Google error code, never a stack trace.
 */

const fail = (message: string): ActionResult<never> => ({ ok: false, message })

function readable(error: unknown, fallback: string): string {
  if (error instanceof GateError) return error.message
  if (error instanceof GoogleAdsError) return error.message
  if (error instanceof Error && error.name === 'ForbiddenError') return error.message
  return error instanceof Error ? error.message : fallback
}

/* ------------------------------------------------------------- accounts */

/**
 * Connect a Google Ads account by its ten-digit customer id.
 *
 * When credentials are configured we ask Google to confirm the account exists
 * and pull its real name, currency and time zone — getting the currency wrong
 * means every budget on screen is a lie. Without credentials the account is
 * recorded as pending so the rest of the product can be used meanwhile.
 */
export async function connectAdAccountAction(input: {
  customerId: string
  managerCustomerId?: string
  label?: string
}): Promise<ActionResult<{ id: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch (e) {
    return fail(readable(e, 'You do not have permission to connect accounts.'))
  }

  const customerId = normaliseCustomerId(input.customerId)
  if (customerId.length !== 10) {
    return fail(
      'A Google Ads account number is ten digits — you will find it at the top right of your Google Ads screen, written like 123-456-7890.',
    )
  }

  let details = {
    descriptiveName: input.label?.trim() || `Account ${customerId}`,
    currencyCode: auth.workspace.settings?.currency ?? 'GBP',
    timeZone: auth.workspace.settings?.defaultTimezone ?? 'Europe/London',
    isManager: false,
    testAccount: false,
  }
  // 'disconnected' rather than a bespoke "pending": the account number is
  // recorded but no working connection to Google exists yet.
  let status: 'connected' | 'disconnected' | 'error' = 'disconnected'
  let lastError: string | null = hasGoogleAds()
    ? null
    : 'Google Ads credentials are not configured yet, so this account has not been verified.'

  if (hasGoogleAds()) {
    try {
      const live = await describeCustomer({
        customerId,
        loginCustomerId: input.managerCustomerId ?? null,
      })
      details = {
        descriptiveName: input.label?.trim() || live.descriptiveName,
        currencyCode: live.currencyCode,
        timeZone: live.timeZone,
        isManager: live.isManager,
        testAccount: live.testAccount,
      }
      status = 'connected'
    } catch (e) {
      // Not fatal: record what we know and show the reason, rather than
      // discarding the account number the user just typed.
      status = 'error'
      lastError = readable(e, 'Google would not confirm that account.')
    }
  }

  const [row] = await db
    .insert(adAccounts)
    .values({
      workspaceId: auth.workspace.id,
      provider: 'google_ads',
      customerId,
      managerCustomerId: input.managerCustomerId ? normaliseCustomerId(input.managerCustomerId) : null,
      status,
      lastError,
      lastSyncAt: status === 'connected' ? new Date() : null,
      ...details,
    })
    .onConflictDoUpdate({
      target: [adAccounts.workspaceId, adAccounts.provider, adAccounts.customerId],
      set: { ...details, status, lastError, lastSyncAt: new Date() },
    })
    .returning({ id: adAccounts.id })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'ads.account_connected',
    subjectType: 'ad_account',
    subjectId: row.id,
    summary: `Google Ads account ${customerId} ${status === 'connected' ? 'connected' : `recorded (${status})`}.`,
    payload: { customerId, status, testAccount: details.testAccount },
  })

  revalidatePath('/ads')
  revalidatePath('/settings')

  return {
    ok: status !== 'error',
    message:
      status === 'connected'
        ? details.testAccount
          ? `Connected "${details.descriptiveName}". Note this is a Google test account — campaigns created here never actually run.`
          : `Connected "${details.descriptiveName}" (${details.currencyCode}).`
        : status === 'disconnected'
          ? 'Account saved. It will be verified once the Google Ads credentials are added.'
          : (lastError ?? 'Could not verify the account.'),
    data: { id: row.id },
  }
}

/* ------------------------------------------------------------ generate */

export type DraftInput = {
  id?: string
  name?: string
  brief: string
  objective: 'sales' | 'leads' | 'traffic' | 'awareness'
  finalUrl: string
  dailyBudget: number
  geoCriterionIds: string[]
  languages?: string[]
  accountId?: string | null
  campaignId?: string | null
  conversionAction?: string | null
  endDate?: string | null
  instruction?: string
  /** Steer the copy with the latest competitor landscape, and add competitor brands as negatives. */
  useCompetitorContext?: boolean
}

/**
 * Turn a sentence into a complete campaign.
 *
 * The channel, bidding strategy and every Google-facing setting come from the
 * objective table in code; only the words and the keyword themes come from the
 * model, and those are repaired against Google's limits before being saved.
 */
export async function generateCampaignAction(
  input: DraftInput,
): Promise<ActionResult<{ id: string; repaired: number; simulated: boolean; warnings: number }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'ads:create')
  } catch (e) {
    return fail(readable(e, 'You do not have permission to build campaigns.'))
  }

  if (!input.brief.trim()) return fail('Tell me in a sentence what you are selling and to whom.')
  if (!input.finalUrl.trim()) return fail('Add the web page people should land on when they click.')
  if (!(input.dailyBudget > 0)) return fail('Set a daily budget above zero.')
  if (input.geoCriterionIds.length === 0) return fail('Choose at least one place to advertise in.')

  const objective = objectiveDef(input.objective)
  const finalUrl = normaliseUrl(input.finalUrl)

  const [account] = input.accountId
    ? await db
        .select()
        .from(adAccounts)
        .where(and(eq(adAccounts.workspaceId, auth.workspace.id), eq(adAccounts.id, input.accountId)))
        .limit(1)
    : []

  const profile = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.isDefault, true)))
    .limit(1)
    .then((r) => r[0] ?? null)

  const geoTargets = input.geoCriterionIds
    .map((id) => GEO_PRESETS.find((g) => g.criterionId === id))
    .filter((g): g is (typeof GEO_PRESETS)[number] => Boolean(g))
    .map((g) => ({ criterionId: g.criterionId, name: g.name }))

  const currencyCode = account?.currencyCode ?? auth.workspace.settings?.currency ?? 'GBP'
  const competitorContext = input.useCompetitorContext ? await competitorContextFor(auth.workspace.id) : null

  // Reserve the row first so the generator can seed from a stable id — a
  // regenerate then produces a different plan, and a reload produces the same one.
  const name = input.name?.trim() || defaultName(input.brief, geoTargets[0]?.name)
  const [row] = input.id
    ? await db
        .select({ id: adCampaigns.id })
        .from(adCampaigns)
        .where(and(eq(adCampaigns.workspaceId, auth.workspace.id), eq(adCampaigns.id, input.id)))
        .limit(1)
    : await db
        .insert(adCampaigns)
        .values({
          workspaceId: auth.workspace.id,
          campaignId: input.campaignId ?? null,
          accountId: account?.id ?? null,
          name,
          objective: input.objective,
          channelType: objective.channelType,
          biddingStrategy: objective.biddingStrategy,
          dailyBudgetMicros: toMicros(input.dailyBudget),
          currencyCode,
          geoTargets,
          languages: input.languages?.length ? input.languages : ['1000'],
          finalUrl,
          conversionAction: input.conversionAction ?? null,
          endDate: input.endDate ?? null,
          briefText: input.brief,
          competitorContext,
          createdBy: auth.user.id,
        })
        .returning({ id: adCampaigns.id })

  if (!row) return fail('Campaign not found.')

  try {
    const generated = await generateAdCampaign({
      workspaceId: auth.workspace.id,
      userId: auth.user.id,
      seedId: `${row.id}:${input.instruction ?? ''}`,
      brief: input.brief,
      objective: input.objective,
      businessName: auth.workspace.name,
      finalUrl,
      currencyCode,
      dailyBudget: input.dailyBudget,
      locations: geoTargets.map((g) => g.name),
      profile,
      instruction: input.instruction,
      competitiveContext: competitorContext,
    })

    await db
      .update(adCampaigns)
      .set({
        name,
        accountId: account?.id ?? null,
        campaignId: input.campaignId ?? null,
        objective: input.objective,
        channelType: objective.channelType,
        biddingStrategy: objective.biddingStrategy,
        dailyBudgetMicros: toMicros(input.dailyBudget),
        currencyCode,
        geoTargets,
        languages: input.languages?.length ? input.languages : ['1000'],
        finalUrl,
        conversionAction: input.conversionAction ?? null,
        endDate: input.endDate ?? null,
        briefText: input.brief,
        competitorContext,
        structure: generated.structure,
        status: 'draft',
        updatedAt: new Date(),
      })
      .where(eq(adCampaigns.id, row.id))

    // A regenerated plan is a different campaign in every way that matters, so
    // any approval granted for the previous version no longer applies.
    if (input.id) await bumpVersion(row.id)

    const report = validateCampaign({
      name,
      finalUrl,
      dailyBudget: input.dailyBudget,
      currencyCode,
      geoTargets: geoTargets.map((g) => g.criterionId),
      languages: input.languages?.length ? input.languages : ['1000'],
      structure: generated.structure,
      suggestedMinDailyBudget: objective.suggestedMinDailyBudget,
      conversionAction: input.conversionAction,
      objectiveKey: input.objective,
    })

    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      action: input.id ? 'ads.regenerated' : 'ads.created',
      subjectType: 'ad_campaign',
      subjectId: row.id,
      summary: `"${name}" — ${report.counts.adGroups} ad groups, ${report.counts.keywords} keywords, ${report.counts.headlines} headlines.`,
      payload: {
        simulated: generated.simulated,
        repaired: generated.repaired,
        objective: input.objective,
        competitorLandscapeId: competitorContext?.landscapeId ?? null,
      },
    })

    revalidatePath('/ads')
    revalidatePath(`/ads/${row.id}`)

    return {
      ok: true,
      message: generated.simulated
        ? `Built ${report.counts.adGroups} ad groups with ${report.counts.keywords} keywords, using the built-in campaign builder.`
        : `Built ${report.counts.adGroups} ad groups with ${report.counts.keywords} keywords.`,
      data: {
        id: row.id,
        repaired: generated.repaired,
        simulated: generated.simulated,
        warnings: report.warnings.length,
      },
    }
  } catch (e) {
    return fail(readable(e, 'Could not build the campaign.'))
  }
}

/* ---------------------------------------------------------------- edits */

/** Save a hand-edited plan. Bumps the version, which invalidates any approval. */
export async function saveStructureAction(input: {
  id: string
  structure: AdCampaignStructure
}): Promise<ActionResult<{ errors: number; warnings: number }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'ads:create')
  } catch (e) {
    return fail(readable(e, 'You do not have permission to edit campaigns.'))
  }

  const [campaign] = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.workspaceId, auth.workspace.id), eq(adCampaigns.id, input.id)))
    .limit(1)
  if (!campaign) return fail('Campaign not found.')
  if (campaign.status === 'live' || campaign.status === 'publishing') {
    return fail('This campaign is already in Google. Changes have to be made there.')
  }

  const { structure } = autoRepair(input.structure)
  await db
    .update(adCampaigns)
    .set({ structure, status: 'draft', updatedAt: new Date() })
    .where(eq(adCampaigns.id, input.id))
  await bumpVersion(input.id)

  const report = validateCampaign({
    name: campaign.name,
    finalUrl: campaign.finalUrl ?? '',
    dailyBudget: campaign.dailyBudgetMicros / 1_000_000,
    currencyCode: campaign.currencyCode,
    geoTargets: campaign.geoTargets.map((g) => g.criterionId),
    languages: campaign.languages,
    structure,
    suggestedMinDailyBudget: objectiveDef(campaign.objective).suggestedMinDailyBudget,
    conversionAction: campaign.conversionAction,
    objectiveKey: campaign.objective,
  })

  revalidatePath(`/ads/${input.id}`)
  return {
    ok: report.ok,
    message: report.ok
      ? 'Saved. Because the plan changed, it needs approving again before it can go to Google.'
      : `Saved, but ${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} would stop Google accepting it.`,
    data: { errors: report.errors.length, warnings: report.warnings.length },
  }
}

/** Change the money or the targeting without regenerating the copy. */
export async function updateSettingsAction(input: {
  id: string
  dailyBudget?: number
  geoCriterionIds?: string[]
  conversionAction?: string | null
  accountId?: string | null
  endDate?: string | null
}): Promise<ActionResult<null>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'ads:create')
  } catch (e) {
    return fail(readable(e, 'You do not have permission to edit campaigns.'))
  }

  const patch: Record<string, unknown> = { updatedAt: new Date(), status: 'draft' }
  if (typeof input.dailyBudget === 'number') {
    if (!(input.dailyBudget > 0)) return fail('The daily budget has to be more than zero.')
    patch.dailyBudgetMicros = toMicros(input.dailyBudget)
  }
  if (input.geoCriterionIds) {
    if (input.geoCriterionIds.length === 0) return fail('Choose at least one place to advertise in.')
    patch.geoTargets = input.geoCriterionIds
      .map((id) => GEO_PRESETS.find((g) => g.criterionId === id))
      .filter((g): g is (typeof GEO_PRESETS)[number] => Boolean(g))
      .map((g) => ({ criterionId: g.criterionId, name: g.name }))
  }
  if (input.conversionAction !== undefined) patch.conversionAction = input.conversionAction
  if (input.accountId !== undefined) patch.accountId = input.accountId
  if (input.endDate !== undefined) patch.endDate = input.endDate

  await db
    .update(adCampaigns)
    .set(patch)
    .where(and(eq(adCampaigns.workspaceId, auth.workspace.id), eq(adCampaigns.id, input.id)))
  await bumpVersion(input.id)

  revalidatePath(`/ads/${input.id}`)
  return { ok: true, message: 'Saved. It will need approving again before it can go to Google.', data: null }
}

/* --------------------------------------------------------- the gauntlet */

export async function submitCampaignAction(id: string): Promise<ActionResult<{ chain: string; step: string }>> {
  const auth = await requireAuth()
  try {
    const result = await submitForReview({
      workspaceId: auth.workspace.id,
      subjectType: 'ad_campaign',
      subjectId: id,
      actorId: auth.user.id,
    })
    revalidatePath(`/ads/${id}`)
    revalidatePath('/approvals')
    return {
      ok: true,
      message: `Sent to "${result.chainName}" — ${result.stepName} needs to sign it off.`,
      data: { chain: result.chainName, step: result.stepName },
    }
  } catch (e) {
    return fail(readable(e, 'Could not submit the campaign.'))
  }
}

/** Check the campaign against Google's rules without creating anything. */
export async function dryRunAction(id: string): Promise<
  ActionResult<{ problems: { where: string; message: string; fix: string }[]; simulated: boolean }>
> {
  const auth = await requireAuth()
  try {
    const outcome = await dryRun({ workspaceId: auth.workspace.id, adCampaignId: id, actorId: auth.user.id })
    revalidatePath(`/ads/${id}`)
    return {
      ok: outcome.ok,
      message: outcome.message,
      data: { problems: outcome.problems ?? [], simulated: outcome.simulated },
    }
  } catch (e) {
    return fail(readable(e, 'Could not check the campaign.'))
  }
}

export async function pushCampaignAction(id: string): Promise<
  ActionResult<{ simulated: boolean; problems: { where: string; message: string; fix: string }[] }>
> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'ads:push')
  } catch (e) {
    return fail(readable(e, 'You do not have permission to send campaigns to Google.'))
  }
  try {
    const outcome = await pushCampaign({
      workspaceId: auth.workspace.id,
      adCampaignId: id,
      actorId: auth.user.id,
    })
    revalidatePath(`/ads/${id}`)
    revalidatePath('/ads')
    return {
      ok: outcome.ok,
      message: outcome.message,
      data: { simulated: outcome.simulated, problems: outcome.problems ?? [] },
    }
  } catch (e) {
    return fail(readable(e, 'Could not send the campaign to Google.'))
  }
}

/**
 * The one action that starts spending money.
 *
 * `acknowledgedMonthlyCeiling` is not decoration: the client passes back the
 * figure it displayed, and if it does not match what the campaign will actually
 * spend, the action refuses. That closes the window where someone changes the
 * budget in another tab between the confirmation appearing and being clicked.
 */
export async function setLiveAction(input: {
  id: string
  live: boolean
  /** Required when going live: the figure the client actually showed. */
  acknowledgedMonthlyCeiling?: number
}): Promise<ActionResult<{ simulated: boolean }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'ads:golive')
  } catch (e) {
    return fail(readable(e, 'Only an owner or marketing ops can turn a campaign on.'))
  }

  if (input.live) {
    const [campaign] = await db
      .select({ micros: adCampaigns.dailyBudgetMicros, currency: adCampaigns.currencyCode })
      .from(adCampaigns)
      .where(and(eq(adCampaigns.workspaceId, auth.workspace.id), eq(adCampaigns.id, input.id)))
      .limit(1)
    if (!campaign) return fail('Campaign not found.')

    const ceiling = Math.round((campaign.micros / 1_000_000) * 30.4)
    // Absent, not just mismatched, must fail. Leaving it optional meant a stale
    // client or a replayed action could start spending with no confirmation.
    if (typeof input.acknowledgedMonthlyCeiling !== 'number') {
      return fail(
        'This campaign was not confirmed against its budget. Reopen it, check the figures and turn it on from there.',
      )
    }
    if (Math.abs(input.acknowledgedMonthlyCeiling - ceiling) > 1) {
      return fail(
        `The budget changed while you were looking at this. It will now spend up to ${campaign.currency} ${ceiling} a month, not ${campaign.currency} ${input.acknowledgedMonthlyCeiling}. Check it and try again.`,
      )
    }
  }

  try {
    const outcome = await setLive({
      workspaceId: auth.workspace.id,
      adCampaignId: input.id,
      actorId: auth.user.id,
      live: input.live,
    })
    revalidatePath(`/ads/${input.id}`)
    revalidatePath('/ads')
    return { ok: outcome.ok, message: outcome.message, data: { simulated: outcome.simulated } }
  } catch (e) {
    return fail(readable(e, input.live ? 'Could not turn the campaign on.' : 'Could not pause the campaign.'))
  }
}

/* -------------------------------------------------------------- helpers */

/**
 * Incremented in SQL rather than read-then-written, so two people saving at once
 * cannot land on the same version number and quietly keep an approval alive.
 */
async function bumpVersion(id: string) {
  await db
    .update(adCampaigns)
    .set({ version: sql`${adCampaigns.version} + 1` })
    .where(eq(adCampaigns.id, id))
}

function normaliseUrl(url: string): string {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed.replace(/^\/+/, '')}`
}

function defaultName(brief: string, place?: string): string {
  const words = brief.trim().split(/\s+/).slice(0, 6).join(' ')
  const base = words.length > 60 ? `${words.slice(0, 57)}…` : words
  return place ? `${base} — ${place}` : base
}
