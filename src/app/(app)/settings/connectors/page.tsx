import type { Metadata } from 'next'
import { AlertTriangle, Plug, Send, Share2 } from 'lucide-react'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { socialAccounts } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import {
  deliveryMissing,
  env,
  hasClickSend,
  hasSendGrid,
  hasWordPress,
  socialConfigured,
  socialMissing,
} from '@/lib/env'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Card, StatTile } from '@/components/ui/primitives'
import { CONNECTORS } from '@/lib/connectors/registry'
import { ConnectorGrid, type ConnectorView } from '@/components/settings/connectors'
import { SocialConnect, type SocialAccountView } from '@/components/settings/social-connect'
import { DeliveryStatus } from '@/components/settings/delivery-status'
import { ReadOnlyNotice } from '@/components/settings/bits'
import { connectorDirectory } from '../queries'

export const metadata: Metadata = { title: 'Integrations' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v || undefined

export default async function ConnectorsPage({ searchParams }: { searchParams: SearchParams }) {
  const auth = await requireAuth()
  const rows = await connectorDirectory(auth.workspace.id)
  const canManage = can(auth.role, 'connector:manage')

  /**
   * Never `select()`: the row carries an encrypted access token, and the only
   * reliable way to keep it out of a client component is to never fetch it.
   */
  const social = await db
    .select({
      id: socialAccounts.id,
      provider: socialAccounts.provider,
      channel: socialAccounts.channel,
      kind: socialAccounts.kind,
      externalId: socialAccounts.externalId,
      displayName: socialAccounts.displayName,
      avatarUrl: socialAccounts.avatarUrl,
      tokenHint: socialAccounts.tokenHint,
      expiresAt: socialAccounts.expiresAt,
      scopes: socialAccounts.scopes,
      status: socialAccounts.status,
      isDefault: socialAccounts.isDefault,
      lastError: socialAccounts.lastError,
      lastPublishAt: socialAccounts.lastPublishAt,
      createdAt: socialAccounts.createdAt,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.workspaceId, auth.workspace.id))
    // Defaults first: the destination a channel actually publishes to is the
    // one people come here to check, so it should not be third in a list.
    .orderBy(desc(socialAccounts.isDefault), asc(socialAccounts.createdAt))

  const socialAccountViews: SocialAccountView[] = social.map((a) => ({
    ...a,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    lastPublishAt: a.lastPublishAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }))

  // The OAuth callback cannot render, so it redirects back here with its outcome
  // in the query string. Both values are attacker-supplied — the tone is matched
  // against a fixed pair and the message is capped, since it is only ever shown
  // as text.
  const params = await searchParams
  const outcome = one(params.connect)
  const tone: 'ok' | 'error' | null =
    outcome === 'ok' ? 'ok' : outcome === 'error' ? 'error' : null
  const message = one(params.message)?.slice(0, 400)
  const notice = tone && message ? { tone, message } : null

  const map: Record<string, ConnectorView> = {}
  for (const r of rows) {
    map[r.provider] = {
      provider: r.provider,
      status: r.status,
      scopes: r.scopes,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      lastError: r.lastError,
      publishedItems: r.publishedItems,
    }
  }

  const connected = rows.filter((r) => r.status === 'connected')
  const unhealthy = rows.filter((r) => r.status === 'degraded' || r.status === 'error')
  const totalSends = rows.reduce((a, r) => a + (r.status === 'connected' ? r.publishedItems : 0), 0)

  // A channel with no connected connector is a channel the scheduler cannot
  // actually deliver on, however good the content is.
  const coveredChannels = new Set(
    connected.flatMap((c) => CONNECTORS.find((d) => d.provider === c.provider)?.channels ?? []),
  )

  return (
    <PageBody className="max-w-[1140px]">
      <section className="mb-8">
        <SectionHeading
          title="Publishing accounts"
          description="The real LinkedIn and Facebook destinations this workspace posts to. Everything below this is the integration layer around them."
        />
        <SocialConnect
          accounts={socialAccountViews}
          linkedin={{ configured: socialConfigured('linkedin'), missing: socialMissing('linkedin') }}
          facebook={{ configured: socialConfigured('facebook'), missing: socialMissing('facebook') }}
          canManage={canManage}
          notice={notice}
        />
      </section>

      <section className="mb-8">
        <SectionHeading
          title="Delivery"
          description="Whether a scheduled email, text or blog post actually leaves the building, or is recorded as simulated. Test each one before a campaign depends on it."
        />
        <DeliveryStatus
          email={{
            configured: hasSendGrid(),
            missing: deliveryMissing('sendgrid'),
            from: env().SENDGRID_FROM_EMAIL ?? null,
          }}
          sms={{ configured: hasClickSend(), missing: deliveryMissing('clicksend') }}
          website={{
            configured: hasWordPress(),
            missing: deliveryMissing('wordpress'),
            from: env().WORDPRESS_URL ?? null,
            goesLive: env().WORDPRESS_POST_STATUS === 'publish',
          }}
          canManage={canManage}
        />
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Connected"
          value={connected.length}
          hint={`${CONNECTORS.length} integrations available`}
          icon={<Plug className="h-4 w-4" />}
        />
        <StatTile
          label="Channels deliverable"
          value={coveredChannels.size}
          hint={
            coveredChannels.size === 0
              ? 'nothing can be published'
              : [...coveredChannels].slice(0, 3).join(', ') + (coveredChannels.size > 3 ? '…' : '')
          }
          icon={<Share2 className="h-4 w-4" />}
        />
        <StatTile
          label="Sends carried"
          value={totalSends.toLocaleString('en-GB')}
          hint="via connected integrations"
          icon={<Send className="h-4 w-4" />}
        />
        <StatTile
          label="Needing attention"
          value={unhealthy.length}
          delta={
            unhealthy.length > 0 ? { value: 'degraded', direction: 'down', good: false } : undefined
          }
          hint={unhealthy.length === 0 ? 'every connection is healthy' : undefined}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
      </div>

      <Card className="mt-6 p-4">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Every integration sits behind one adapter interface, so the scheduler, the segment sync and the
          metrics pipeline never learn a vendor's name. That is what makes adding the next platform a new
          adapter file rather than a change to the publishing path — and it is why disconnecting one here
          degrades a channel rather than breaking the product.
        </p>
      </Card>

      {!canManage && (
        <div className="mt-4">
          <ReadOnlyNotice what="the integrations" />
        </div>
      )}

      <div className="mt-6">
        <ConnectorGrid connectors={map} canManage={canManage} />
      </div>
    </PageBody>
  )
}
