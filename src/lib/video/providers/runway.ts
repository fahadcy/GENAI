/**
 * Runway, as the failover provider.
 *
 * Shape checked against docs.dev.runwayml.com on 1 Sep 2026:
 *
 *   POST /v1/text_to_video  → { id }
 *   GET  /v1/tasks/{id}     → { status: PENDING|RUNNING|SUCCEEDED|FAILED|CANCELLED, output: [url] }
 *
 * The API version header is pinned. An unpinned version means Runway can
 * change the response shape under a running deployment, which is exactly the
 * failure the fallback provider exists to absorb rather than cause.
 */

import { env } from '@/lib/env'
import { dimensionsFor, type VideoAspect, type VideoProviderId, type VideoResolution } from '../catalogue'
import {
  VideoProviderError,
  type ProviderDownload,
  type ProviderError,
  type ProviderJob,
  type ProviderSubmitRequest,
  type VideoProvider,
} from './types'

const BASE = 'https://api.dev.runwayml.com'
const RUNWAY_VERSION = '2024-11-06'
const TIMEOUT_MS = 60_000

export class RunwayProvider implements VideoProvider {
  readonly id: VideoProviderId = 'runway'
  private readonly apiKey: string | null
  private readonly base: string
  private readonly http: typeof fetch

  constructor(opts: { apiKey?: string | null; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = opts.apiKey ?? env().RUNWAY_API_KEY ?? null
    this.base = opts.baseUrl ?? BASE
    this.http = opts.fetchImpl ?? fetch
  }

  get configured(): boolean {
    return Boolean(this.apiKey)
  }

  async submit(req: ProviderSubmitRequest): Promise<ProviderJob> {
    this.assertConfigured()
    const firstReference = req.referenceAssets?.find((r) => r.kind !== 'logo') ?? req.referenceAssets?.[0] ?? null
    const path = firstReference ? '/v1/image_to_video' : '/v1/text_to_video'
    const body: Record<string, unknown> = {
      model: req.model,
      promptText: req.prompt,
      ratio: runwayRatio(req.aspectRatio, req.resolution),
      duration: req.durationSeconds,
      ...(typeof req.seed === 'number' ? { seed: req.seed } : {}),
    }
    if (firstReference) body.promptImage = firstReference.url
    if (req.negativePrompt) body.negativePrompt = req.negativePrompt
    if (req.referenceAssets && req.referenceAssets.length > 1) {
      body.imageReferences = req.referenceAssets.map((r) => ({
        uri: r.url,
        tag: r.kind,
        name: r.label ?? r.kind,
      }))
    }

    const res = await this.request(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    const json = (await res.json()) as { id?: string }
    if (!json.id) {
      throw new VideoProviderError('bad_response', 'Runway accepted the request but returned no task id.')
    }
    return { providerJobId: json.id, status: 'queued', progress: 0, error: null, assetRef: null, expiresAt: null }
  }

  async poll(providerJobId: string): Promise<ProviderJob> {
    this.assertConfigured()

    const res = await this.request(`${this.base}/v1/tasks/${encodeURIComponent(providerJobId)}`, { method: 'GET' })
    const json = (await res.json()) as {
      status?: string
      progress?: number
      output?: string[]
      failure?: string
      failureCode?: string
    }
    const status = (json.status ?? '').toUpperCase()

    if (status === 'SUCCEEDED') {
      const url = json.output?.[0]
      if (!url) throw new VideoProviderError('bad_response', 'Runway reported SUCCEEDED with no output URL.')
      return {
        providerJobId,
        status: 'succeeded',
        progress: 100,
        error: null,
        assetRef: url,
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      }
    }

    if (status === 'FAILED' || status === 'CANCELLED' || status === 'CANCELED') {
      return {
        providerJobId,
        status: 'failed',
        progress: null,
        error: mapRunwayError(json.failureCode, json.failure, status),
        assetRef: null,
        expiresAt: null,
      }
    }

    return {
      providerJobId,
      status: status === 'PENDING' ? 'queued' : 'running',
      progress: typeof json.progress === 'number' ? Math.round(json.progress * 100) : null,
      error: null,
      assetRef: null,
      expiresAt: null,
    }
  }

  async download(job: ProviderJob): Promise<ProviderDownload> {
    if (!job.assetRef) {
      throw new VideoProviderError('bad_response', 'Runway task completed with no output URL.')
    }
    // Output URLs are pre-signed and carry no Runway auth header.
    const res = await this.http(job.assetRef)
    if (res.status === 403 || res.status === 404) {
      throw new VideoProviderError(
        'asset_expired',
        'Runway no longer has this video. Output URLs are short-lived and this one was not stored in time.',
      )
    }
    if (!res.ok) {
      throw new VideoProviderError('unreachable', `Downloading from Runway failed with ${res.status}.`, {
        retryable: true,
      })
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'video/mp4',
    }
  }

  private assertConfigured(): void {
    if (this.configured) return
    throw new VideoProviderError('not_configured', 'RUNWAY_API_KEY is not set, so Runway cannot be used.')
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await this.http(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${this.apiKey}`,
          'X-Runway-Version': RUNWAY_VERSION,
        },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const retryable = res.status === 429 || res.status >= 500
        throw new VideoProviderError(String(res.status), `Runway refused the request (${res.status}).`, {
          retryable,
          providerMessage: text.slice(0, 500),
        })
      }
      return res
    } catch (e) {
      if (e instanceof VideoProviderError) throw e
      if ((e as Error)?.name === 'AbortError') {
        throw new VideoProviderError('timeout', `Runway did not respond within ${TIMEOUT_MS / 1000}s.`, {
          retryable: true,
          cause: e,
        })
      }
      throw new VideoProviderError('unreachable', `Could not reach Runway: ${(e as Error).message}`, {
        retryable: true,
        cause: e,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Runway wants explicit pixel dimensions rather than "9:16". */
export function runwayRatio(aspect: VideoAspect, resolution: VideoResolution): string {
  const { width, height } = dimensionsFor(aspect, resolution)
  return `${width}:${height}`
}

export function mapRunwayError(code: string | undefined, message: string | undefined, status: string): ProviderError {
  const text = message ?? `Runway task ${status.toLowerCase()}.`
  const contentRefusal = /content|moderation|policy|safety/i.test(`${code ?? ''} ${text}`)
  const retryable = !contentRefusal && /internal|timeout|capacity|unavailable/i.test(`${code ?? ''} ${text}`)
  return { code: code ?? status, message: text, retryable, contentRefusal }
}
