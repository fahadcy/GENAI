import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  approvalChains,
  approvalRequests,
  brandProfiles,
  videoGenerations,
  type VideoGeneration,
} from '@/lib/db/schema'
import {
  durationsFor,
  videoModel,
  VIDEO_CATALOGUE,
  type VideoAspect,
  type VideoResolution,
} from '@/lib/video/catalogue'
import { capsForPlan, resolveVideoPolicy, resolutionRank, VideoPolicyError } from '@/lib/video/policy'
import { currentVideoCeiling, monthToDateVideoSpend, videoPlaybackUrl, workspacePlan } from '@/lib/video/service'
import { env, videoProviderConfigured, videoProviderKeyName } from '@/lib/env'
import type { Plan } from '@/lib/db/schema'

/** The clips in this workspace, newest first. */
export async function listVideos(workspaceId: string, limit = 24): Promise<VideoGeneration[]> {
  return db
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.workspaceId, workspaceId))
    .orderBy(desc(videoGenerations.createdAt))
    .limit(limit)
}

export function toGalleryItem(row: VideoGeneration) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    version: row.version,
    simulated: row.simulated,
    playbackUrl: videoPlaybackUrl(row),
    mediaCheckPassed: row.mediaCheck ? row.mediaCheck.passed : null,
    blockingFindings: (row.mediaCheck?.findings ?? []).filter((f) => f.severity === 'high').map((f) => f.message),
    lastError: row.lastError,
    actualCostCents: row.actualCostCents,
    estimatedCostCents: row.estimatedCostCents,
    durationSeconds: row.mediaFacts?.durationSeconds ?? null,
    width: row.mediaFacts?.width ?? null,
    height: row.mediaFacts?.height ?? null,
    hasAudio: row.mediaFacts?.hasAudio ?? null,
    watermark: row.provenance?.watermark ?? null,
  }
}

/**
 * What the composer is allowed to offer.
 *
 * Resolved from the plan and the catalogue on the server, so the controls can
 * only ever show combinations that exist. A picker offering fifteen seconds
 * when the model generates four, six or eight is a provider rejection waiting
 * to happen — after the person has already confirmed a spend.
 *
 * Every model the plan allows is listed, including ones with no credentials
 * yet. Hiding those would leave someone wondering why the platform seems to
 * have one model; showing them with the variable they are waiting on turns a
 * mystery into a task.
 */
export async function composerOptions(workspaceId: string) {
  const plan: Plan = await workspacePlan(workspaceId)
  const caps = capsForPlan(plan)

  let durations: number[] = []
  let resolutions: VideoResolution[] = []
  let modelLabel = 'the simulator'

  try {
    const policy = resolveVideoPolicy({
      plan,
      primaryProvider: env().VIDEO_PROVIDER,
      resolution: caps.maxResolution,
      // Any duration the catalogue offers; the resolve call reports the rest.
      durationSeconds: caps.maxDurationSeconds,
      aspectRatio: '9:16',
      variants: 1,
      audio: caps.allowAudio,
    })
    modelLabel = policy.model.label
    resolutions = policy.model.resolutions.filter((r) => resolutionRank(r) <= resolutionRank(caps.maxResolution))
    durations = durationsFor(policy.model, policy.resolution).filter((d) => d <= caps.maxDurationSeconds)
  } catch (e) {
    // A plan with no usable model should still render the page, with the
    // reason visible, rather than throwing a 500 at the person.
    if (!(e instanceof VideoPolicyError)) throw e
    const fallback = videoModel('simulator-v1')
    if (fallback) {
      resolutions = fallback.resolutions
      durations = fallback.durationsSeconds
    }
  }

  const ceilingCents = await currentVideoCeiling(workspaceId, plan)
  const spentCents = await monthToDateVideoSpend(workspaceId)

  /**
   * The picker's options. Ordered cheapest first, because the price is the
   * thing a person is actually choosing between — a list ordered by vendor
   * name makes them work that out for themselves.
   */
  const models = VIDEO_CATALOGUE.filter((m) => caps.allowedModels.includes(m.id))
    .map((m) => ({
      id: m.id,
      label: m.label,
      providerId: m.providerId,
      configured: videoProviderConfigured(m.providerId),
      keyName: videoProviderKeyName(m.providerId),
      /** Silent rate; the composer adds audio itself so the figure tracks the toggle. */
      centsPerSecond: m.centsPerSecond,
      centsPerSecondByResolution: m.centsPerSecondByResolution ?? null,
      audioCentsPerSecond: m.audioCentsPerSecond,
      generatesAudio: m.generatesAudio,
      maxReferenceImages: Math.min(caps.maxReferenceImages, m.maxReferenceImages),
      durations: m.durationsSeconds.filter((d) => d <= caps.maxDurationSeconds),
      resolutions: m.resolutions.filter((r) => resolutionRank(r) <= resolutionRank(caps.maxResolution)),
      aspectRatios: m.aspectRatios as VideoAspect[],
      resolutionDurationLocks: m.resolutionDurationLocks ?? null,
      note: m.notes ?? null,
      pricingSource: m.priceSource,
    }))
    .sort(
      (a, b) =>
        (a.centsPerSecondByResolution?.['720p'] ?? a.centsPerSecond) -
        (b.centsPerSecondByResolution?.['720p'] ?? b.centsPerSecond),
    )

  const defaultModel =
    models.find((m) => m.configured && m.providerId === env().VIDEO_PROVIDER)?.id ??
    models.find((m) => m.configured)?.id ??
    models[0]?.id ??
    'simulator-v1'

  return {
    plan,
    caps,
    modelLabel,
    models,
    defaultModel,
    durations: durations.length > 0 ? durations : [4, 6, 8],
    resolutions: resolutions.length > 0 ? resolutions : ['720p'],
    maxVariants: caps.maxVariants,
    ceilingCents,
    spentCents,
    remainingCents: Math.max(0, ceilingCents - spentCents),
  }
}

export type ComposerOptions = Awaited<ReturnType<typeof composerOptions>>
export type ComposerModel = ComposerOptions['models'][number]

/** The default brand profile, for rendering a score report. */
export async function defaultBrandProfile(workspaceId: string) {
  const [row] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, workspaceId), eq(brandProfiles.isDefault, true)))
    .limit(1)
  return row ?? null
}

/** The open approval request for a clip, if it has one. */
export async function openRequestFor(workspaceId: string, videoId: string) {
  const [row] = await db
    .select({ request: approvalRequests, chain: approvalChains })
    .from(approvalRequests)
    .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.subjectType, 'video'),
        eq(approvalRequests.subjectId, videoId),
        inArray(approvalRequests.status, ['pending']),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1)

  if (!row) return null
  const step = row.chain.steps[row.request.currentStep]
  return {
    id: row.request.id,
    chainName: row.chain.name,
    stepName: step?.name ?? `Step ${row.request.currentStep + 1}`,
    currentStep: row.request.currentStep,
    steps: row.chain.steps,
  }
}
