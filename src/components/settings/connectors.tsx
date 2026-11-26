'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, KeyRound, Plug, RefreshCw, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader, type BadgeTone } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { ChannelChip, RelativeTime } from '@/components/domain'
import { CATEGORY_LABEL, CONNECTORS, type ConnectorCategory } from '@/lib/connectors/registry'
import { retryConnector, setConnectorStatus } from '@/app/(app)/settings/actions'

export type ConnectorView = {
  provider: string
  status: string
  scopes: string[]
  lastSyncAt: string | null
  lastError: string | null
  publishedItems: number
}

const CAPABILITY_LABEL: Record<string, string> = {
  publish: 'Publishing',
  audience_sync: 'Audience sync',
  metrics: 'Metrics',
  contact_import: 'Contact import',
  suppression_sync: 'Suppression sync',
}

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  error: { label: 'Failing', tone: 'danger' },
  disconnected: { label: 'Not connected', tone: 'neutral' },
}

export function ConnectorGrid({
  connectors,
  canManage,
}: {
  connectors: Record<string, ConnectorView>
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)

  const act = async (provider: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(provider)
    try {
      const result = await fn()
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const categories = Object.keys(CATEGORY_LABEL) as ConnectorCategory[]

  return (
    <div className="space-y-6">
      {categories.map((category) => {
        const defs = CONNECTORS.filter((c) => c.category === category)
        if (defs.length === 0) return null
        const live = defs.filter((d) => connectors[d.provider]?.status === 'connected').length

        return (
          <Card key={category} className="overflow-hidden">
            <CardHeader
              title={CATEGORY_LABEL[category]}
              description={`${live} of ${defs.length} connected.`}
              icon={<Plug className="h-4 w-4" />}
            />
            <ul className="divide-y divide-line">
              {defs.map((def) => {
                const row = connectors[def.provider]
                const status = STATUS[row?.status ?? 'disconnected'] ?? STATUS.disconnected
                const connected = row?.status === 'connected'
                const unhealthy = row?.status === 'degraded' || row?.status === 'error'

                return (
                  <li key={def.provider} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13.5px] font-semibold text-ink">{def.displayName}</span>
                          <Badge tone={status.tone} dot>
                            {status.label}
                          </Badge>
                          {!def.firstRelease && !row && <Badge tone="neutral">Roadmap</Badge>}
                        </div>
                        <p className="mt-1 max-w-xl text-[13px] leading-snug text-ink-muted">
                          {def.description}
                        </p>

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          {def.channels.length > 0 && (
                            <span className="flex flex-wrap gap-1">
                              {def.channels.map((c) => (
                                <ChannelChip key={c} channel={c} size="sm" />
                              ))}
                            </span>
                          )}
                          <span className="flex flex-wrap gap-1">
                            {def.capabilities.map((cap) => (
                              <span
                                key={cap}
                                className="rounded bg-bg-inset px-1.5 py-0.5 text-2xs text-ink-muted"
                              >
                                {CAPABILITY_LABEL[cap] ?? cap}
                              </span>
                            ))}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {unhealthy && canManage && (
                          <Button
                            size="xs"
                            variant="secondary"
                            loading={busy === def.provider}
                            onClick={() => void act(def.provider, () => retryConnector(def.provider))}
                          >
                            <RefreshCw className="h-3 w-3" />
                            Resync
                          </Button>
                        )}
                        {canManage &&
                          (connected || unhealthy ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              loading={busy === def.provider}
                              onClick={() =>
                                void act(def.provider, () => setConnectorStatus(def.provider, 'disconnected'))
                              }
                            >
                              Disconnect
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="secondary"
                              loading={busy === def.provider}
                              onClick={() =>
                                void act(def.provider, () => setConnectorStatus(def.provider, 'connected'))
                              }
                            >
                              <KeyRound className="h-3 w-3" />
                              Connect
                            </Button>
                          ))}
                      </div>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-faint">
                      <span className="inline-flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        {def.authType === 'oauth2'
                          ? 'OAuth 2.0 — no credentials stored in GenAI'
                          : def.authType === 'api_key'
                            ? 'API key, encrypted at rest'
                            : 'Basic auth, encrypted at rest'}
                      </span>
                      {row?.lastSyncAt && (
                        <span>
                          last sync <RelativeTime date={row.lastSyncAt} />
                        </span>
                      )}
                      {row && row.publishedItems > 0 && (
                        <span className="tnum">{row.publishedItems} sends carried</span>
                      )}
                      {row && row.scopes.length > 0 && (
                        <span className="truncate font-mono">{row.scopes.join(' · ')}</span>
                      )}
                    </div>

                    {row?.lastError && (
                      <p
                        className={cn(
                          'mt-2.5 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs leading-relaxed',
                          row.status === 'error' ? 'bg-danger-bg text-danger-fg' : 'bg-warn-bg text-warn-fg',
                        )}
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {row.lastError}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </Card>
        )
      })}
    </div>
  )
}
