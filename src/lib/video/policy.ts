/**
 * What a workspace is allowed to generate, and what it costs — decided in
 * code, from the plan, never from a prompt.
 *
 * This is the same rule `lib/ads/objectives.ts` follows for paid search: the
 * model writes words, it never decides how money is spent. Applied to video
 * that means a brief can influence the prompt and nothing else. Which model,
 * what resolution, how many variants and how long the clip runs are settled
 * here.
 *
 * Everything in this file is a pure function. No database, no clock except
 * what is passed in — which matters, because this is the code that decides
 * whether money is spent, and it should be testable without either.
 */

import { createHash } from 'node:crypto'
import { can } from '@/lib/auth/rbac'
import type { Plan, Role } from '@/lib/db/schema'
import {
  dimensionsFor,
  supportsCombination,
  totalCentsPerSecond,
  videoModel,
  videoModelsFor,
  VIDEO_CATALOGUE,
  type VideoAspect,
  type VideoModelSpec,
  type VideoProviderId,
  type VideoResolution,
} from './catalogue'

export class VideoPolicyError extends Error {
  readonly status = 400
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'VideoPolicyError'
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------- plan caps */

export type VideoPlanCaps = {
  allowedModels: string[]
  maxResolution: VideoResolution
  maxVariants: number
  maxDurationSeconds: number
  maxReferenceImages: number
  allowAudio: boolean
  /** Monthly ceiling in cents, before any workspace override. */
  defaultCeilingCents: number
}

const RESOLUTION_ORDER: VideoResolution[] = ['480p', '720p', '1080p', '4k']
export const resolutionRank = (r: VideoResolution) => RESOLUTION_ORDER.indexOf(r)

/**
 * Caps per plan. Trial gets the simulator only — a free trial that can spend
 * real money on someone else's card is not a trial, it is an incident waiting
 * to be written up.
 */
export const VIDEO_PLAN_CAPS: Record<Plan, VideoPlanCaps> = {
  trial: {
    allowedModels: ['simulator-v1'],
    maxResolution: '720p',
    maxVariants: 2,
    maxDurationSeconds: 6,
    maxReferenceImages: 2,
    allowAudio: false,
    defaultCeilingCents: 0,
  },
  studio: {
    allowedModels: ['simulator-v1', 'veo-3.1-lite-generate-preview', 'gen4_turbo', 'wan3'],
    maxResolution: '720p',
    maxVariants: 2,
    maxDurationSeconds: 15,
    maxReferenceImages: 3,
    allowAudio: false,
    defaultCeilingCents: 5_000,
  },
  growth: {
    allowedModels: ['simulator-v1', 'veo-3.1-lite-generate-preview', 'gen4_turbo', 'wan3'],
    maxResolution: '1080p',
    maxVariants: 4,
    maxDurationSeconds: 30,
    maxReferenceImages: 4,
    allowAudio: true,
    defaultCeilingCents: 25_000,
  },
  scale: {
    allowedModels: VIDEO_CATALOGUE.map((m) => m.id),
    maxResolution: '1080p',
    maxVariants: 4,
    maxDurationSeconds: 30,
    maxReferenceImages: 6,
    allowAudio: true,
    defaultCeilingCents: 75_000,
  },
  enterprise: {
    allowedModels: VIDEO_CATALOGUE.map((m) => m.id),
    maxResolution: '4k',
    maxVariants: 4,
    maxDurationSeconds: 30,
    maxReferenceImages: 10,
    allowAudio: true,
    defaultCeilingCents: 250_000,
  },
}

export const capsForPlan = (plan: Plan): VideoPlanCaps => VIDEO_PLAN_CAPS[plan] ?? VIDEO_PLAN_CAPS.trial

/* ----------------------------------------------------------- channel fit */

/**
 * The aspect ratio a channel actually wants. Someone generating for LinkedIn
 * should not have to know the answer, and should not be able to get it wrong
 * by accident and find out at the approval stage.
 */
export const VIDEO_CHANNEL_ASPECT: Partial<Record<string, VideoAspect>> = {
  instagram: '9:16',
  facebook: '4:5',
  linkedin: '1:1',
  x: '16:9',
  meta_ads: '9:16',
  google_ads: '16:9',
  web: '16:9',
  blog: '16:9',
  email: '16:9',
}

export type ChannelVideoSpec = {
  label: string
  aspectRatios: VideoAspect[]
  minDurationSeconds: number
  maxDurationSeconds: number
  minShortEdgePx: number
  maxFileSizeBytes: number
  audioStronglyExpected: boolean
  /** [verify] Platform specs drift without announcement. Re-check quarterly. */
  verifiedOn: string
}

const MB = 1024 * 1024

export const CHANNEL_VIDEO_SPECS: Partial<Record<string, ChannelVideoSpec>> = {
  instagram: {
    label: 'Instagram',
    aspectRatios: ['9:16', '1:1', '4:5'],
    minDurationSeconds: 3,
    maxDurationSeconds: 90,
    minShortEdgePx: 500,
    maxFileSizeBytes: 500 * MB,
    audioStronglyExpected: true,
    verifiedOn: '2026-09-01',
  },
  facebook: {
    label: 'Facebook',
    aspectRatios: ['4:5', '1:1', '16:9', '9:16'],
    minDurationSeconds: 1,
    maxDurationSeconds: 241,
    minShortEdgePx: 500,
    maxFileSizeBytes: 4096 * MB,
    audioStronglyExpected: false,
    verifiedOn: '2026-09-01',
  },
  linkedin: {
    label: 'LinkedIn',
    aspectRatios: ['1:1', '16:9', '9:16'],
    minDurationSeconds: 3,
    maxDurationSeconds: 1800,
    minShortEdgePx: 360,
    maxFileSizeBytes: 200 * MB,
    audioStronglyExpected: false,
    verifiedOn: '2026-09-01',
  },
  x: {
    label: 'X',
    aspectRatios: ['16:9', '1:1'],
    minDurationSeconds: 1,
    maxDurationSeconds: 140,
    minShortEdgePx: 360,
    maxFileSizeBytes: 512 * MB,
    audioStronglyExpected: false,
    verifiedOn: '2026-09-01',
  },
  meta_ads: {
    label: 'Meta Ads',
    aspectRatios: ['9:16', '4:5', '1:1'],
    minDurationSeconds: 1,
    maxDurationSeconds: 241,
    minShortEdgePx: 500,
    maxFileSizeBytes: 4096 * MB,
    audioStronglyExpected: true,
    verifiedOn: '2026-09-01',
  },
  google_ads: {
    label: 'Google Ads',
    aspectRatios: ['16:9', '1:1', '9:16'],
    minDurationSeconds: 5,
    maxDurationSeconds: 180,
    minShortEdgePx: 480,
    maxFileSizeBytes: 256 * MB,
    audioStronglyExpected: false,
    verifiedOn: '2026-09-01',
  },
  web: {
    label: 'Website',
    aspectRatios: ['16:9', '1:1'],
    minDurationSeconds: 1,
    maxDurationSeconds: 300,
    minShortEdgePx: 480,
    maxFileSizeBytes: 150 * MB,
    audioStronglyExpected: false,
    verifiedOn: '2026-09-01',
  },
}

/* -------------------------------------------------------------- resolving */

export type ResolveInput = {
  plan: Plan
  primaryProvider: VideoProviderId
  requestedModel?: string | null
  resolution: VideoResolution
  durationSeconds: number
  aspectRatio: VideoAspect
  variants: number
  audio: boolean
  referenceCount?: number
}

export type ResolvedVideoPolicy = {
  model: VideoModelSpec
  resolution: VideoResolution
  durationSeconds: number
  aspectRatio: VideoAspect
  variants: number
  audio: boolean
  maxReferenceImages: number
  width: number
  height: number
  /** Every place the request was reduced, so the studio can say so out loud. */
  adjustments: string[]
}

/**
 * Clamp a request to what the plan and the provider allow.
 *
 * Clamping for plan caps — asking for 1080p on Studio is a reasonable thing to
 * do and getting 720p with a note is a reasonable answer. Refusing for
 * combinations the provider does not offer at all, because silently changing
 * the length of a clip somebody scripted to eight seconds is not a small edit.
 */
export function resolveVideoPolicy(input: ResolveInput): ResolvedVideoPolicy {
  const caps = capsForPlan(input.plan)
  const adjustments: string[] = []

  /* 1. Model. */
  let model: VideoModelSpec | undefined
  if (input.requestedModel) {
    const requested = videoModel(input.requestedModel)
    if (!requested) {
      throw new VideoPolicyError('unknown_model', `There is no video model called "${input.requestedModel}".`)
    }
    if (caps.allowedModels.includes(requested.id)) {
      model = requested
    } else {
      adjustments.push(`${requested.label} is not available on the ${input.plan} plan; using the best model it allows.`)
    }
  }

  if (!model) {
    const preferred = videoModelsFor(input.primaryProvider).filter((m) => caps.allowedModels.includes(m.id))
    const pool = preferred.length > 0 ? preferred : VIDEO_CATALOGUE.filter((m) => caps.allowedModels.includes(m.id))
    if (pool.length === 0) {
      throw new VideoPolicyError('no_models', `The ${input.plan} plan has no video models enabled.`)
    }
    // Cheapest allowed. An unasked-for default should never be the dear one.
    model = pool.reduce((a, b) =>
      totalCentsPerSecond(b, input.audio, input.resolution) < totalCentsPerSecond(a, input.audio, input.resolution) ? b : a,
    )
  }

  /* 2. Resolution: plan cap first, then what the model offers. */
  let resolution = input.resolution
  if (resolutionRank(resolution) > resolutionRank(caps.maxResolution)) {
    adjustments.push(`Resolution reduced to ${caps.maxResolution} — the ${input.plan} plan's maximum.`)
    resolution = caps.maxResolution
  }
  if (!model.resolutions.includes(resolution)) {
    const best =
      [...model.resolutions]
        .sort((a, b) => resolutionRank(b) - resolutionRank(a))
        .find((r) => resolutionRank(r) <= resolutionRank(resolution)) ?? model.resolutions[0]
    adjustments.push(`${model.label} does not offer ${resolution}; using ${best}.`)
    resolution = best
  }

  /* 3. Aspect ratio: refuse rather than reframe. */
  if (!model.aspectRatios.includes(input.aspectRatio)) {
    throw new VideoPolicyError(
      'unsupported_aspect',
      `${model.label} cannot generate ${input.aspectRatio}. It offers ${model.aspectRatios.join(', ')}. Choose another ratio or another model — nothing has been generated.`,
      { model: model.id, requested: input.aspectRatio, available: model.aspectRatios },
    )
  }

  /* 4. Duration. */
  let durationSeconds = input.durationSeconds
  if (durationSeconds > caps.maxDurationSeconds) {
    const allowed = model.durationsSeconds.filter((d) => d <= caps.maxDurationSeconds)
    if (allowed.length === 0) {
      throw new VideoPolicyError(
        'duration_unavailable',
        `The ${input.plan} plan caps clips at ${caps.maxDurationSeconds}s and ${model.label} offers no duration that short (${model.durationsSeconds.join(', ')}s).`,
      )
    }
    const clamped = Math.max(...allowed)
    adjustments.push(`Length reduced to ${clamped}s — the ${input.plan} plan caps clips at ${caps.maxDurationSeconds}s.`)
    durationSeconds = clamped
  }

  if (!supportsCombination(model, resolution, durationSeconds)) {
    const offered = model.durationsSeconds.filter((d) => supportsCombination(model!, resolution, d))
    throw new VideoPolicyError(
      'unsupported_duration',
      offered.length > 0
        ? `${model.label} does not generate ${durationSeconds}s at ${resolution}. At that resolution it offers ${offered.join(', ')}s. Nothing has been generated.`
        : `${model.label} does not generate ${resolution} at any length.`,
      { model: model.id, resolution, requestedDuration: durationSeconds, offeredDurations: offered },
    )
  }

  const referenceCount = Math.max(0, Math.floor(input.referenceCount ?? 0))
  if (referenceCount > 0 && model.referenceImagesRequireDurationSeconds && durationSeconds !== model.referenceImagesRequireDurationSeconds) {
    if (
      model.referenceImagesRequireDurationSeconds > caps.maxDurationSeconds ||
      !supportsCombination(model, resolution, model.referenceImagesRequireDurationSeconds)
    ) {
      throw new VideoPolicyError(
        'reference_duration_unavailable',
        `${model.label} can use reference images only at ${model.referenceImagesRequireDurationSeconds}s, which is not available with the current plan and resolution. Choose another model or remove the image references — nothing has been generated.`,
        { model: model.id, requiredDuration: model.referenceImagesRequireDurationSeconds },
      )
    }
    adjustments.push(
      `Length set to ${model.referenceImagesRequireDurationSeconds}s — ${model.label} only accepts reference images at that duration.`,
    )
    durationSeconds = model.referenceImagesRequireDurationSeconds
  }

  /* 5. Variants. */
  let variants = Math.max(1, Math.floor(input.variants))
  if (variants > caps.maxVariants) {
    adjustments.push(`Reduced to ${caps.maxVariants} variants — the ${input.plan} plan's maximum.`)
    variants = caps.maxVariants
  }

  /* 6. Audio. */
  let audio = input.audio
  if (audio && !caps.allowAudio) {
    adjustments.push(`Audio is not available on the ${input.plan} plan.`)
    audio = false
  }
  if (audio && !model.generatesAudio) {
    adjustments.push(`${model.label} does not generate audio.`)
    audio = false
  }

  let maxReferenceImages = Math.min(caps.maxReferenceImages, model.maxReferenceImages)
  if (referenceCount > 0 && (!model.supportsImageToVideo || model.maxReferenceImages === 0)) {
    throw new VideoPolicyError(
      'references_unsupported',
      `${model.label} does not accept reference images. Choose full Veo 3.1, Runway, Simulator, or remove the image references — nothing has been generated.`,
      { model: model.id },
    )
  }
  if (referenceCount > maxReferenceImages) {
    adjustments.push(
      `Using the first ${maxReferenceImages} reference image${maxReferenceImages === 1 ? '' : 's'} — ${model.label} on the ${input.plan} plan cannot use ${referenceCount}.`,
    )
  }

  const { width, height } = dimensionsFor(input.aspectRatio, resolution)

  return {
    model,
    resolution,
    durationSeconds,
    aspectRatio: input.aspectRatio,
    variants,
    audio,
    maxReferenceImages,
    width,
    height,
    adjustments,
  }
}

/* --------------------------------------------------------------- costing */

export type VideoCostEstimate = {
  perVariantCents: number
  totalCents: number
  variants: number
  model: string
  providerId: VideoProviderId
  durationSeconds: number
  resolution: VideoResolution
  audio: boolean
  /**
   * A stable hash of everything that affects the price, including the total.
   * The client echoes it back on confirmation; the server refuses if it no
   * longer matches what it would quote now.
   */
  fingerprint: string
}

export function estimateVideoCost(policy: ResolvedVideoPolicy): VideoCostEstimate {
  const perSecond = totalCentsPerSecond(policy.model, policy.audio, policy.resolution)
  const perVariantCents = Math.ceil(perSecond * policy.durationSeconds)
  const totalCents = perVariantCents * policy.variants

  return {
    perVariantCents,
    totalCents,
    variants: policy.variants,
    model: policy.model.id,
    providerId: policy.model.providerId,
    durationSeconds: policy.durationSeconds,
    resolution: policy.resolution,
    audio: policy.audio,
    fingerprint: fingerprint({
      model: policy.model.id,
      perSecond,
      durationSeconds: policy.durationSeconds,
      resolution: policy.resolution,
      variants: policy.variants,
      audio: policy.audio,
      totalCents,
    }),
  }
}

export function fingerprint(parts: Record<string, string | number | boolean>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${String(parts[k])}`)
    .join('&')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/**
 * The server side of the acknowledgement handshake, lifted from the campaign
 * enable path: the server quotes a figure, the client displays it, and the
 * client hands the same figure back on confirmation. If they disagree the
 * server refuses. That closes the window where a price change, a plan change
 * or a second browser tab means somebody confirmed one number and was charged
 * another.
 */
export function verifyAcknowledgement(args: {
  current: VideoCostEstimate
  presentedFingerprint: string
  presentedTotalCents: number
}): void {
  const { current, presentedFingerprint, presentedTotalCents } = args
  if (presentedFingerprint === current.fingerprint && presentedTotalCents === current.totalCents) return

  throw new VideoPolicyError(
    'estimate_stale',
    presentedTotalCents === current.totalCents
      ? 'The settings changed after the cost was displayed. Review the figure and confirm again — nothing has been generated.'
      : `The cost changed after it was shown to you: you confirmed ${money(presentedTotalCents)}, the current estimate is ${money(current.totalCents)}. Nothing has been generated.`,
    { presentedTotalCents, currentTotalCents: current.totalCents },
  )
}

export type CeilingCheck = {
  ceilingCents: number
  spentCents: number
  remainingCents: number
  requestedCents: number
  wouldExceed: boolean
}

export function checkCeiling(args: {
  ceilingCents: number
  spentCents: number
  requestedCents: number
}): CeilingCheck {
  return {
    ceilingCents: args.ceilingCents,
    spentCents: args.spentCents,
    remainingCents: Math.max(0, args.ceilingCents - args.spentCents),
    requestedCents: args.requestedCents,
    wouldExceed: args.spentCents + args.requestedCents > args.ceilingCents,
  }
}

/**
 * Refuse rather than degrade.
 *
 * The tempting alternative — quietly dropping four variants to one, or 1080p
 * to 720p, to fit under the ceiling — produces a workspace where nobody can
 * explain why last Tuesday's ads look worse. A refusal naming both figures is
 * worth more than a generation nobody asked for.
 */
export function enforceCeiling(check: CeilingCheck): void {
  if (!check.wouldExceed) return
  throw new VideoPolicyError(
    'ceiling_reached',
    check.ceilingCents === 0
      ? 'Video generation is not included on this plan. Nothing has been generated.'
      : `This would spend ${money(check.requestedCents)} against ${money(check.remainingCents)} left of the ${money(check.ceilingCents)} monthly video budget. Nothing has been generated — an owner or marketing ops can raise the ceiling.`,
    check as unknown as Record<string, unknown>,
  )
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/* ----------------------------------------------------------------- roles */

/**
 * Permissions, not a private role list — the matrix in `lib/auth/rbac.ts` is
 * the one place that answers "who may do what", and a second copy here would
 * drift the first time someone changed a role.
 *
 * `video:create` is deliberately split from `asset:create`: writing a brief
 * costs nothing, generating spends real money per attempt. `video:budget`
 * sits with the roles that may turn a campaign on, for the same reason.
 */
export function canGenerateVideo(role: Role): boolean {
  return can(role, 'video:create')
}

export function canRaiseVideoCeiling(role: Role): boolean {
  return can(role, 'video:budget')
}
