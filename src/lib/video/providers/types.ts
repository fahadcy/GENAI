/**
 * The video provider interface.
 *
 * This is the most load-bearing file in the video module, and it earned that
 * before a line of it shipped. The feature was specified against OpenAI's
 * sora-2; OpenAI then announced that the Videos API and every Sora model shut
 * down on 24 September 2026, with no replacement named in their deprecation
 * table. Three weeks' notice on the vendor we had just chosen. The cost of
 * that was one conversation rather than a rewrite, because the provider was
 * always going to sit behind an interface.
 *
 * Three methods, because that is all a video provider actually does: take a
 * job, say how it is going, hand over the bytes. Anything richer — credits,
 * characters, remixes, extensions — is one vendor's idea and does not belong
 * in the shared shape.
 */

import type { VideoAspect, VideoProviderId, VideoResolution } from '../catalogue'
import type { VideoReferenceAsset } from '../prompt'

export type ProviderSubmitRequest = {
  model: string
  prompt: string
  negativePrompt?: string | null
  aspectRatio: VideoAspect
  resolution: VideoResolution
  durationSeconds: number
  audio: boolean
  seed?: number | null
  referenceAssets?: VideoReferenceAsset[]
  /** Correlation id for provider-side logs. Carries no client data. */
  idempotencyKey: string
}

export type ProviderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type ProviderError = {
  code: string
  /** The provider's own words, verbatim. Never rewritten or summarised. */
  message: string
  retryable: boolean
  /**
   * True when the provider refused on content grounds. Kept separate because
   * Google does not charge for output a safety filter blocks, and because
   * retrying is pointless: the prompt has to change and a person needs to see
   * why.
   */
  contentRefusal: boolean
}

export type ProviderJob = {
  providerJobId: string
  status: ProviderJobStatus
  /** 0–100 where the provider reports it, null where it does not. */
  progress: number | null
  error: ProviderError | null
  /** Where the finished file lives on the provider's side, while it lasts. */
  assetRef: string | null
  /** When the provider deletes it. Veo: 48 hours. */
  expiresAt: Date | null
}

export type ProviderDownload = {
  bytes: Uint8Array
  contentType: string
}

export interface VideoProvider {
  readonly id: VideoProviderId
  /** Whether credentials are present. False routes to the simulator. */
  readonly configured: boolean
  submit(req: ProviderSubmitRequest): Promise<ProviderJob>
  poll(providerJobId: string): Promise<ProviderJob>
  download(job: ProviderJob): Promise<ProviderDownload>
}

export class VideoProviderError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly contentRefusal: boolean
  readonly providerMessage: string | null

  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; contentRefusal?: boolean; providerMessage?: string | null; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'VideoProviderError'
    this.code = code
    this.retryable = opts.retryable ?? false
    this.contentRefusal = opts.contentRefusal ?? false
    this.providerMessage = opts.providerMessage ?? null
  }
}
