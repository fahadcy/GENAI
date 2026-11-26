/**
 * Provider selection and failover.
 *
 * The failover rule is deliberately narrow. We fail over when a provider is
 * unreachable, timing out or rate-limiting — infrastructure problems, where
 * the same request would have succeeded elsewhere. We never fail over on a
 * content refusal or a rejected request: shopping a blocked prompt around
 * until a laxer filter accepts it is not resilience, it is a governance hole,
 * and this platform's whole argument is that it does not have those.
 *
 * Failover is also recorded on the row. A campaign that quietly ran on the
 * backup provider for a fortnight — different provenance metadata, different
 * bill — is not something anyone should discover later.
 */

import { env } from '@/lib/env'
import type { VideoProviderId } from '../catalogue'
import { RunwayProvider } from './runway'
import { SimulatorProvider } from './simulator'
import { VideoProviderError, type ProviderJob, type ProviderSubmitRequest, type VideoProvider } from './types'
import { VeoProvider } from './veo'

export * from './types'
export { VeoProvider } from './veo'
export { RunwayProvider } from './runway'
export { SimulatorProvider, REFUSAL_TRIGGER, RETRYABLE_TRIGGER } from './simulator'

/** Codes meaning "this provider, right now" rather than "this request". */
const INFRASTRUCTURE = new Set(['unreachable', 'timeout', 'not_configured', '429', '500', '502', '503', '504'])

let registry: ProviderRegistry | null = null

export class ProviderRegistry {
  private readonly providers: Map<VideoProviderId, VideoProvider>
  readonly primary: VideoProviderId
  readonly fallback: VideoProviderId | null

  constructor(opts: {
    providers: Map<VideoProviderId, VideoProvider>
    primary: VideoProviderId
    fallback: VideoProviderId | null
  }) {
    this.providers = opts.providers
    this.primary = opts.primary
    this.fallback = opts.fallback
  }

  get(id: VideoProviderId): VideoProvider {
    const p = this.providers.get(id)
    if (!p) throw new VideoProviderError('not_configured', `No video provider registered for "${id}".`)
    return p
  }

  /**
   * Which provider a new request should go to: the primary if it has
   * credentials, else the fallback, else the simulator. A platform that
   * refuses to start because one key is missing is worse than one that runs on
   * the simulator and labels every record it writes.
   */
  resolve(preferred?: VideoProviderId | null): VideoProvider {
    for (const id of [preferred, this.primary, this.fallback, 'simulator' as const]) {
      if (!id) continue
      const p = this.providers.get(id)
      if (p?.configured) return p
    }
    throw new VideoProviderError('not_configured', 'No video provider is configured, not even the simulator.')
  }

  /** Submit with one failover attempt, reporting which provider took the job. */
  async submitWithFailover(
    req: ProviderSubmitRequest,
    preferred?: VideoProviderId | null,
  ): Promise<{ job: ProviderJob; provider: VideoProvider; failedOverFrom: VideoProviderId | null }> {
    const first = this.resolve(preferred)
    try {
      return { job: await first.submit(req), provider: first, failedOverFrom: null }
    } catch (e) {
      const code = e instanceof VideoProviderError ? e.code : 'unreachable'
      const contentRefusal = e instanceof VideoProviderError && e.contentRefusal
      const canFailover =
        !contentRefusal && INFRASTRUCTURE.has(code) && this.fallback !== null && this.fallback !== first.id

      if (!canFailover) throw e

      const backup = this.providers.get(this.fallback as VideoProviderId)
      if (!backup?.configured) throw e

      // The model id belongs to whichever provider is about to run it.
      const job = await backup.submit({ ...req, model: defaultModelFor(backup.id) })
      return { job, provider: backup, failedOverFrom: first.id }
    }
  }
}

export function videoProviders(): ProviderRegistry {
  if (registry) return registry
  const e = env()
  const providers = new Map<VideoProviderId, VideoProvider>([
    ['google', new VeoProvider()],
    ['runway', new RunwayProvider()],
    ['simulator', new SimulatorProvider()],
  ])
  registry = new ProviderRegistry({
    providers,
    primary: e.VIDEO_PROVIDER,
    fallback: e.VIDEO_FALLBACK_PROVIDER ?? null,
  })
  return registry
}

/** Test seam: replace the registry, or reset it with null. */
export function __setVideoProviders(next: ProviderRegistry | null): void {
  registry = next
}

export function defaultModelFor(id: VideoProviderId): string {
  switch (id) {
    case 'google':
      return 'veo-3.1-lite-generate-preview'
    case 'runway':
      return 'gen4_turbo'
    case 'simulator':
      return 'simulator-v1'
  }
}
