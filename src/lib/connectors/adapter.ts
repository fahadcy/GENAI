import 'server-only'
import { seededRandom } from '@/lib/ai/gateway'
import type { Asset, Connector } from '@/lib/db/schema'
import { CONNECTOR_BY_PROVIDER } from './registry'

/**
 * One interface, every channel. The scheduler and publisher only ever see this.
 *
 * The bundled implementation is a faithful simulator: it validates payloads the
 * way a real API would, applies channel constraints, and fails a small fraction
 * of calls with realistic, retryable errors so the retry and dead-letter paths
 * are genuinely exercised rather than theoretical. Swapping in a live vendor
 * means implementing this interface — nothing upstream changes.
 */
export interface ChannelAdapter {
  readonly provider: string
  publish(input: PublishInput): Promise<PublishResult>
  syncAudience?(input: AudienceSyncInput): Promise<AudienceSyncResult>
}

export type PublishInput = {
  asset: Pick<Asset, 'id' | 'title' | 'body' | 'channel' | 'imageUrl'>
  recipients: number
  scheduledAt: Date
  connector: Connector | null
  attempt: number
}

export type PublishResult =
  | {
      ok: true
      externalRef: string
      acceptedRecipients: number
      /**
       * Anything the person should read on the timeline that a count cannot
       * carry — what a text send actually cost, how many numbers the carrier
       * rejected. Optional because most channels have nothing to add.
       */
      note?: string
    }
  | { ok: false; retryable: boolean; error: string }

export type AudienceSyncInput = {
  segmentId: string
  segmentName: string
  contactIds: string[]
  connector: Connector | null
}

export type AudienceSyncResult = { ok: boolean; synced: number; matchRate: number; error?: string }

/* -------------------------------------------------------------- limits */

const HARD_LIMITS: Record<string, number> = {
  x: 280,
  sms: 160,
  google_ads: 90,
  meta_ads: 125,
  push: 150,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
}

/* ------------------------------------------------------------ simulator */

class SimulatedAdapter implements ChannelAdapter {
  constructor(readonly provider: string) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const { asset, attempt } = input

    // Validate the way a real API would, before any network cost.
    const limit = HARD_LIMITS[asset.channel]
    if (limit && (asset.body.body?.length ?? 0) > limit) {
      return {
        ok: false,
        retryable: false,
        error: `${this.provider} rejected the payload: body is ${asset.body.body.length} characters, limit is ${limit}.`,
      }
    }
    if (asset.channel === 'email' && !asset.body.subject?.trim()) {
      return { ok: false, retryable: false, error: 'Email requires a subject line.' }
    }
    if (input.recipients === 0 && ['email', 'sms', 'push'].includes(asset.channel)) {
      return {
        ok: false,
        retryable: false,
        error: 'No reachable recipients: every contact in the segment is suppressed or lacks consent for this channel.',
      }
    }

    await sleep(120 + Math.floor(seededRandom(asset.id + attempt)() * 260))

    // ~6% transient failure on the first attempt, decaying after that: enough
    // to make the retry path real without making demos flaky.
    const rng = seededRandom(`${asset.id}:${this.provider}:${attempt}`)
    const failureRate = attempt === 0 ? 0.06 : 0.02
    if (rng() < failureRate) {
      const errors = [
        `${this.provider} returned 503 Service Unavailable.`,
        `${this.provider} rate limit reached (429). Retry after backoff.`,
        `Upstream timeout contacting ${this.provider}.`,
      ]
      return { ok: false, retryable: true, error: errors[Math.floor(rng() * errors.length)] }
    }

    return {
      ok: true,
      externalRef: `${this.provider}_${Math.floor(rng() * 1e12).toString(36)}`,
      acceptedRecipients: input.recipients,
    }
  }

  async syncAudience(input: AudienceSyncInput): Promise<AudienceSyncResult> {
    await sleep(200)
    const def = CONNECTOR_BY_PROVIDER.get(this.provider)
    if (def && !def.capabilities.includes('audience_sync')) {
      return { ok: false, synced: 0, matchRate: 0, error: `${this.provider} does not support audience sync.` }
    }
    // Real ad platforms match on hashed email and never match everyone.
    const rng = seededRandom(input.segmentId + this.provider)
    const matchRate = 0.58 + rng() * 0.3
    return {
      ok: true,
      synced: Math.floor(input.contactIds.length * matchRate),
      matchRate: Math.round(matchRate * 1000) / 1000,
    }
  }
}

const cache = new Map<string, ChannelAdapter>()

export function adapterFor(provider: string): ChannelAdapter {
  let a = cache.get(provider)
  if (!a) {
    a = new SimulatedAdapter(provider)
    cache.set(provider, a)
  }
  return a
}

/** Default provider for a channel when the workspace has not connected one. */
export function defaultProviderFor(channel: string): string {
  const map: Record<string, string> = {
    email: 'sendgrid',
    sms: 'clicksend',
    push: 'firebase_push',
    linkedin: 'linkedin_pages',
    facebook: 'meta_business',
    instagram: 'meta_business',
    x: 'x_api',
    google_ads: 'google_ads',
    meta_ads: 'meta_ads',
    blog: 'wordpress',
    web: 'wordpress',
  }
  return map[channel] ?? 'internal_cms'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
