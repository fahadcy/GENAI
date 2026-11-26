/**
 * The video model catalogue: what each provider can actually do, and what it
 * costs.
 *
 * Two rules about this file.
 *
 * 1. Capabilities are declared here, not guessed at the UI. Veo generates 4, 6
 *    or 8 seconds; Runway does 5 or 10. A duration control that offers 15
 *    produces a provider rejection *after* someone has confirmed a spend they
 *    were shown, which is the one failure this whole module is arranged to
 *    prevent.
 *
 * 2. Every price carries the date it was checked and the page it came from.
 *    This market moves on a scale of weeks: the model this feature was
 *    originally specified against — OpenAI's sora-2 — was announced for
 *    shutdown on 24 September 2026, with no replacement named, between the
 *    spec being written and the code being written. So `pricingIsStale` marks
 *    an unverified price in the studio rather than presenting it as fact.
 */

export type VideoProviderId = 'google' | 'runway' | 'simulator'
export type VideoResolution = '480p' | '720p' | '1080p' | '4k'
export type VideoAspect = '16:9' | '9:16' | '1:1' | '4:5'

export type VideoModelSpec = {
  id: string
  providerId: VideoProviderId
  label: string
  durationsSeconds: number[]
  resolutions: VideoResolution[]
  aspectRatios: VideoAspect[]
  /** Resolutions offered at only some durations — Veo's 1080p is 8s only. */
  resolutionDurationLocks?: Partial<Record<VideoResolution, number[]>>
  generatesAudio: boolean
  supportsImageToVideo: boolean
  maxReferenceImages: number
  /** Some providers only permit reference images on a specific clip length. */
  referenceImagesRequireDurationSeconds?: number
  supportsNegativePrompt: boolean
  centsPerSecond: number
  centsPerSecondByResolution?: Partial<Record<VideoResolution, number>>
  /** Extra cents per second when audio is generated. */
  audioCentsPerSecond: number
  /**
   * How long the provider keeps the rendered file. This is why storage is not
   * optional: Veo deletes generated video after two days, so without our own
   * copy the only artefact of an approved, published advertisement is gone
   * inside 48 hours.
   */
  providerRetentionHours: number
  provenance: { watermark: string | null; visibleWatermark: boolean | null; note: string | null }
  priceVerifiedOn: string
  priceSource: string
  notes?: string
}

export const PRICE_STALE_AFTER_DAYS = 45

/**
 * Google Veo, via the Gemini API. Capabilities and model ids from
 * ai.google.dev/gemini-api/docs/veo, checked 2 Sep 2026: 4/6/8 second
 * durations, 16:9 or 9:16, 720p with 1080p and 4k at 8 seconds only, native
 * audio, SynthID on all output, `referenceImages` on the full model only,
 * no `negativePrompt` parameter in the current Veo guide, and no charge for
 * output a safety filter blocks.
 *
 * Veo is paid-only — there is no free tier — so a key on a project without
 * billing enabled will be refused however well everything else is configured.
 *
 * Per-second rates are Google's published Veo 3 / Veo 3 Fast figures. Veo 3.1
 * is in preview and had no separately published rate on the day this was
 * checked, so these are the closest published numbers rather than confirmed
 * 3.1 prices. Treat an estimate as indicative until one real invoice has
 * arrived.
 */
const VEO: VideoModelSpec[] = [
  {
    id: 'veo-3.1-lite-generate-preview',
    providerId: 'google',
    label: 'Veo 3.1 Lite',
    durationsSeconds: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    resolutionDurationLocks: { '1080p': [8] },
    generatesAudio: true,
    supportsImageToVideo: true,
    maxReferenceImages: 0,
    supportsNegativePrompt: false,
    centsPerSecond: 10,
    audioCentsPerSecond: 5,
    providerRetentionHours: 48,
    provenance: {
      watermark: 'synthid',
      visibleWatermark: null,
      note: 'All Veo output is SynthID watermarked. Whether a visible mark is also applied depends on the account tier — confirm before a paid placement.',
    },
    priceVerifiedOn: '2026-09-01',
    priceSource: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    notes: 'The default for social variants. It supports a starting image, but not the separate referenceImages field. Google publishes no separate Lite rate, so this uses the published Veo 3 Fast figure — treat an estimate as indicative until one real invoice has arrived.',
  },
  {
    id: 'veo-3.1-generate-preview',
    providerId: 'google',
    label: 'Veo 3.1',
    durationsSeconds: [4, 6, 8],
    resolutions: ['720p', '1080p', '4k'],
    aspectRatios: ['16:9', '9:16'],
    resolutionDurationLocks: { '1080p': [8], '4k': [8] },
    generatesAudio: true,
    supportsImageToVideo: true,
    maxReferenceImages: 3,
    referenceImagesRequireDurationSeconds: 8,
    supportsNegativePrompt: false,
    centsPerSecond: 20,
    audioCentsPerSecond: 20,
    providerRetentionHours: 48,
    provenance: {
      watermark: 'synthid',
      visibleWatermark: null,
      note: 'All Veo output is SynthID watermarked.',
    },
    priceVerifiedOn: '2026-09-01',
    priceSource: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    notes: 'Use this Veo model, not Lite, when passing person/product/style reference images. Reference-image generations are 8-second only; 1080p and 4k are also 8-second only.',
  },
]

/**
 * Runway, as the failover provider. Runway bills in credits at a rate that
 * depends on the plan, so the per-second figure here is a deliberate
 * over-estimate: quoting high and spending less is recoverable, the reverse is
 * a client conversation.
 */
const RUNWAY: VideoModelSpec[] = [
  {
    id: 'gen4_turbo',
    providerId: 'runway',
    label: 'Runway Gen-4 Turbo',
    durationsSeconds: [5, 10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    generatesAudio: false,
    supportsImageToVideo: true,
    maxReferenceImages: 1,
    supportsNegativePrompt: false,
    centsPerSecond: 10,
    audioCentsPerSecond: 0,
    providerRetentionHours: 24,
    provenance: {
      watermark: null,
      visibleWatermark: null,
      note: 'Provenance signalling not confirmed. Verify before relying on it for AI-disclosure obligations.',
    },
    priceVerifiedOn: '2026-09-01',
    priceSource: 'https://docs.dev.runwayml.com/',
    notes: 'Credit billing converted to a conservative per-second figure. Verify against your plan.',
  },
  {
    id: 'wan3',
    providerId: 'runway',
    label: 'Runway WAN 3.0',
    durationsSeconds: [15, 30],
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    generatesAudio: true,
    supportsImageToVideo: true,
    maxReferenceImages: 10,
    supportsNegativePrompt: true,
    // Conservative fallback; exact quoting uses the resolution map below.
    centsPerSecond: 20,
    centsPerSecondByResolution: { '480p': 5, '720p': 10, '1080p': 20 },
    audioCentsPerSecond: 0,
    providerRetentionHours: 24,
    provenance: {
      watermark: null,
      visibleWatermark: null,
      note: 'Runway provenance signalling not confirmed. Verify disclosure requirements before a paid placement.',
    },
    priceVerifiedOn: '2026-09-03',
    priceSource: 'https://docs.dev.runwayml.com/',
    notes: 'Longer social clips with reference images and native audio. WAN 3.0 supports 2-30 second generations; Aurea exposes 15s and 30s presets.',
  },
]

/**
 * The simulator is always present, exactly as the Google Ads simulator is.
 * Its prices are shadow-billed so the ceiling and acknowledgement paths are
 * exercised without a penny being spent, and nothing it produces is ever
 * metered or presented as real footage.
 */
const SIMULATOR: VideoModelSpec[] = [
  {
    id: 'simulator-v1',
    providerId: 'simulator',
    label: 'Simulator',
    durationsSeconds: [4, 6, 8, 10, 15, 30],
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:5'],
    generatesAudio: true,
    supportsImageToVideo: true,
    maxReferenceImages: 10,
    supportsNegativePrompt: true,
    centsPerSecond: 10,
    audioCentsPerSecond: 5,
    providerRetentionHours: 24,
    provenance: {
      watermark: null,
      visibleWatermark: true,
      note: 'Simulated output with a burned-in label. Never presentable as real footage.',
    },
    priceVerifiedOn: '2026-09-01',
    priceSource: 'n/a — simulated, never billed',
  },
]

export const VIDEO_CATALOGUE: VideoModelSpec[] = [...VEO, ...RUNWAY, ...SIMULATOR]

export function videoModel(id: string): VideoModelSpec | undefined {
  return VIDEO_CATALOGUE.find((m) => m.id === id)
}

export function videoModelsFor(providerId: VideoProviderId): VideoModelSpec[] {
  return VIDEO_CATALOGUE.filter((m) => m.providerId === providerId)
}

export function totalCentsPerSecond(
  m: VideoModelSpec,
  audio: boolean,
  resolution?: VideoResolution,
): number {
  const video = resolution ? (m.centsPerSecondByResolution?.[resolution] ?? m.centsPerSecond) : m.centsPerSecond
  return video + (audio && m.generatesAudio ? m.audioCentsPerSecond : 0)
}

export function pricingAgeDays(m: VideoModelSpec, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${m.priceVerifiedOn}T00:00:00Z`)) / 86_400_000)
}

export function pricingIsStale(m: VideoModelSpec, now: Date): boolean {
  return m.providerId !== 'simulator' && pricingAgeDays(m, now) > PRICE_STALE_AFTER_DAYS
}

/** Is this duration/resolution pair actually offered? Veo's 1080p is 8s only. */
export function supportsCombination(
  m: VideoModelSpec,
  resolution: VideoResolution,
  durationSeconds: number,
): boolean {
  if (!m.resolutions.includes(resolution)) return false
  if (!m.durationsSeconds.includes(durationSeconds)) return false
  const lock = m.resolutionDurationLocks?.[resolution]
  return !lock || lock.includes(durationSeconds)
}

/** The durations a picker should offer at a given resolution. */
export function durationsFor(m: VideoModelSpec, resolution: VideoResolution): number[] {
  return m.durationsSeconds.filter((d) => supportsCombination(m, resolution, d))
}

/**
 * Pixel dimensions for an aspect ratio at a resolution.
 *
 * Rounded to even numbers because h.264 with 4:2:0 chroma requires them, so an
 * encoder would round anyway. Predicting 853 and delivering 852 makes the
 * pre-generation check disagree with the post-generation measurement by a
 * pixel, which is the kind of discrepancy that sends somebody hunting for a
 * bug that is not there.
 */
export function dimensionsFor(
  aspect: VideoAspect,
  resolution: VideoResolution,
): { width: number; height: number } {
  const shortEdge: Record<VideoResolution, number> = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 }
  const s = shortEdge[resolution]
  // Floor rather than round: an encoder that has to adjust an odd edge
  // reduces it, so 853 becomes 852 rather than 854.
  const even = (n: number) => Math.floor(n / 2) * 2
  switch (aspect) {
    case '16:9':
      return { width: even((s * 16) / 9), height: s }
    case '9:16':
      return { width: s, height: even((s * 16) / 9) }
    case '1:1':
      return { width: s, height: s }
    case '4:5':
      return { width: s, height: even((s * 5) / 4) }
  }
}
