/**
 * Google Veo, via the Gemini API. The primary provider.
 *
 * Shape checked against ai.google.dev/gemini-api/docs/veo on 1 Sep 2026:
 *
 *   POST /v1beta/models/{model}:predictLongRunning  → { name: "operations/…" }
 *   GET  /v1beta/{operation.name}                   → { done, response | error }
 *   GET  {video.uri}                                → the MP4
 *
 * Veo is in preview, so response shapes move. `extractVideoUri` tries the
 * shapes Google has actually used and, when none match, throws an error
 * carrying the keys it did find. That is the difference between a five-minute
 * fix and an afternoon with a debugger.
 */

import { env } from '@/lib/env'
import { videoModel, type VideoProviderId } from '../catalogue'
import {
  VideoProviderError,
  type ProviderDownload,
  type ProviderError,
  type ProviderJob,
  type ProviderSubmitRequest,
  type VideoProvider,
} from './types'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
const TIMEOUT_MS = 60_000

export class VeoProvider implements VideoProvider {
  readonly id: VideoProviderId = 'google'
  private readonly apiKey: string | null
  private readonly base: string
  private readonly http: typeof fetch

  constructor(opts: { apiKey?: string | null; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = opts.apiKey ?? env().GOOGLE_VIDEO_API_KEY ?? null
    this.base = opts.baseUrl ?? BASE
    this.http = opts.fetchImpl ?? fetch
  }

  get configured(): boolean {
    return Boolean(this.apiKey)
  }

  async submit(req: ProviderSubmitRequest): Promise<ProviderJob> {
    this.assertConfigured()

    const referenceImages = await this.referenceImages(req)
    const instance: Record<string, unknown> = { prompt: req.prompt }
    if (referenceImages.length > 0) instance.referenceImages = referenceImages

    const parameters: Record<string, unknown> = {
      aspectRatio: req.aspectRatio,
      resolution: req.resolution,
      durationSeconds: req.durationSeconds,
      sampleCount: 1,
      // The stricter of the two settings, and the right default for brand-safe
      // advertising.
      personGeneration: 'allow_adult',
    }
    if (typeof req.seed === 'number') parameters.seed = req.seed

    const res = await this.request(
      `${this.base}/models/${encodeURIComponent(req.model)}:predictLongRunning`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instances: [instance], parameters }),
      },
    )

    const json = (await this.json(res)) as { name?: string }
    if (!json.name) {
      throw new VideoProviderError('bad_response', 'Veo accepted the request but returned no operation name.')
    }

    return {
      providerJobId: json.name,
      status: 'queued',
      progress: 0,
      error: null,
      assetRef: null,
      expiresAt: null,
    }
  }

  async poll(providerJobId: string): Promise<ProviderJob> {
    this.assertConfigured()

    const res = await this.request(`${this.base}/${providerJobId}`, { method: 'GET' })
    const json = (await this.json(res)) as {
      done?: boolean
      error?: { code?: number; message?: string; status?: string }
      response?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }

    if (!json.done) {
      const pct = json.metadata?.progressPercent
      return {
        providerJobId,
        status: 'running',
        progress: typeof pct === 'number' ? pct : null,
        error: null,
        assetRef: null,
        expiresAt: null,
      }
    }

    if (json.error) {
      return {
        providerJobId,
        status: 'failed',
        progress: null,
        error: mapGoogleError(json.error),
        assetRef: null,
        expiresAt: null,
      }
    }

    return {
      providerJobId,
      status: 'succeeded',
      progress: 100,
      error: null,
      assetRef: extractVideoUri(json.response ?? {}),
      // Google keeps generated video for two days. Recorded so that a storing
      // job that arrives late can say "we were slow" rather than "it broke".
      expiresAt: new Date(Date.now() + 48 * 3_600_000),
    }
  }

  async download(job: ProviderJob): Promise<ProviderDownload> {
    this.assertConfigured()
    if (!job.assetRef) {
      throw new VideoProviderError('bad_response', 'Veo reported the job complete with no video to download.')
    }

    const res = await this.request(job.assetRef, { method: 'GET' }, true)
    if (res.status === 403 || res.status === 404) {
      throw new VideoProviderError(
        'asset_expired',
        'Veo no longer has this video. Google deletes generated files after 48 hours and this one was not stored in time.',
      )
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'video/mp4',
    }
  }

  /* ------------------------------------------------------------ plumbing */

  private assertConfigured(): void {
    if (this.configured) return
    throw new VideoProviderError(
      'not_configured',
      'GOOGLE_VIDEO_API_KEY is not set, so Veo cannot be used. Set it, or leave it unset and the simulator runs instead.',
    )
  }

  private async request(url: string, init: RequestInit, allowNotFound = false): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await this.http(url, {
        ...init,
        signal: controller.signal,
        headers: { ...(init.headers ?? {}), 'x-goog-api-key': this.apiKey as string },
      })
      if (!res.ok) {
        if (allowNotFound && (res.status === 403 || res.status === 404)) return res
        await this.throwForStatus(res)
      }
      return res
    } catch (e) {
      if (e instanceof VideoProviderError) throw e
      if ((e as Error)?.name === 'AbortError') {
        throw new VideoProviderError('timeout', `Veo did not respond within ${TIMEOUT_MS / 1000}s.`, {
          retryable: true,
          cause: e,
        })
      }
      throw new VideoProviderError('unreachable', `Could not reach Veo: ${(e as Error).message}`, {
        retryable: true,
        cause: e,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async referenceImages(req: ProviderSubmitRequest): Promise<Array<Record<string, unknown>>> {
    const spec = videoModel(req.model)
    if ((req.referenceAssets?.length ?? 0) > 0 && (!spec || spec.maxReferenceImages === 0)) {
      throw new VideoProviderError(
        'references_unsupported',
        `${spec?.label ?? req.model} does not accept reference images. Choose full Veo 3.1, Runway, Simulator, or remove the image references.`,
        { retryable: false },
      )
    }
    if (
      (req.referenceAssets?.length ?? 0) > 0 &&
      spec?.referenceImagesRequireDurationSeconds &&
      req.durationSeconds !== spec.referenceImagesRequireDurationSeconds
    ) {
      throw new VideoProviderError(
        'reference_duration_unavailable',
        `${spec.label} accepts reference images only at ${spec.referenceImagesRequireDurationSeconds}s.`,
        { retryable: false },
      )
    }

    const refs = (req.referenceAssets ?? []).slice(0, spec?.maxReferenceImages ?? 3)
    if (refs.length === 0) return []

    const images: Array<Record<string, unknown>> = []
    for (const ref of refs) {
      const res = await this.http(ref.url, { method: 'GET' })
      if (!res.ok) {
        throw new VideoProviderError(
          'reference_unreachable',
          `Veo could not fetch the ${ref.kind} reference image.`,
          { retryable: false, providerMessage: `${res.status} fetching ${ref.url}` },
        )
      }
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
      if (!/^image\/(png|jpe?g|webp)$/i.test(mimeType)) {
        throw new VideoProviderError(
          'reference_unsupported',
          `The ${ref.kind} reference is ${mimeType}, but Veo reference images must be PNG, JPEG or WebP.`,
          { retryable: false },
        )
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength > 4 * 1024 * 1024) {
        throw new VideoProviderError(
          'reference_too_large',
          `The ${ref.kind} reference image is larger than 4MB. Use a smaller public image URL.`,
          { retryable: false },
        )
      }
      images.push({
        referenceType: 'asset',
        image: {
          bytesBase64Encoded: Buffer.from(bytes).toString('base64'),
          mimeType,
        },
      })
    }
    return images
  }

  private async throwForStatus(res: Response): Promise<never> {
    const text = await res.text().catch(() => '')
    let parsed: { error?: { message?: string; status?: string; code?: number } } = {}
    try {
      parsed = JSON.parse(text)
    } catch {
      /* non-JSON; the raw text is what we keep */
    }
    const mapped = mapGoogleError(parsed.error ?? { code: res.status, message: text })
    throw new VideoProviderError(mapped.code, `Veo refused the request (${res.status}).`, {
      retryable: mapped.retryable,
      contentRefusal: mapped.contentRefusal,
      providerMessage: mapped.message,
    })
  }

  private async json(res: Response): Promise<unknown> {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new VideoProviderError('bad_response', 'Veo returned something that was not JSON.', {
        providerMessage: text.slice(0, 500),
        cause: e,
      })
    }
  }
}

/**
 * Veo has returned the finished video under more than one path across preview
 * revisions. Try the known ones; if none match, say what we actually got.
 */
export function extractVideoUri(response: Record<string, unknown>): string {
  const paths: Array<(r: any) => unknown> = [
    (r) => r?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri,
    (r) => r?.generateVideoResponse?.generatedSamples?.[0]?.video?.videoUri,
    (r) => r?.generatedSamples?.[0]?.video?.uri,
    (r) => r?.predictions?.[0]?.videoUri,
    (r) => r?.predictions?.[0]?.video?.uri,
    (r) => r?.videos?.[0]?.uri,
  ]
  for (const get of paths) {
    const value = get(response)
    if (typeof value === 'string' && value.length > 0) return value
  }
  throw new VideoProviderError(
    'bad_response',
    `Veo reported the job complete but the response carried no video URI in any known shape. The preview API has probably changed — see extractVideoUri() in src/lib/video/providers/veo.ts. Keys received: ${Object.keys(response).join(', ') || '(none)'}.`,
  )
}

/**
 * Google's error statuses mapped to whether a retry could possibly help.
 *
 * The important line is the content refusal: Google does not charge for output
 * blocked by a safety filter, and the same prompt will be blocked again. It
 * goes straight to a human with the reason attached rather than round the
 * retry loop.
 */
export function mapGoogleError(err: { code?: number; message?: string; status?: string }): ProviderError {
  const status = err.status ?? ''
  const message = err.message ?? 'Veo returned an error with no message.'
  const code = err.code ?? 0

  const contentRefusal = /safety|blocked|policy|prohibited|responsible ai/i.test(message) || status === 'FAILED_PRECONDITION'

  const retryable =
    !contentRefusal &&
    (status === 'UNAVAILABLE' ||
      status === 'RESOURCE_EXHAUSTED' ||
      status === 'DEADLINE_EXCEEDED' ||
      status === 'INTERNAL' ||
      code === 429 ||
      code === 500 ||
      code === 503 ||
      code === 504)

  return { code: status || String(code) || 'unknown', message, retryable, contentRefusal }
}
