'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, PlugZap, RefreshCw, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { ChannelChip, RelativeTime, channelLabel } from '@/components/domain'
import { refreshSegmentAction, syncSegmentAction } from '@/app/actions/targeting'
import { SYNC_CHANNELS, providerForChannel } from './shared'

export type ConnectorStatus = {
  provider: string
  displayName: string
  status: string
  lastSyncAt: string | null
  supportsAudienceSync: boolean
}

/** AT-4: choosing where a segment goes, with the connector that will carry it. */
export function SyncTargetPicker({
  value,
  onChange,
  connectors,
  disabled,
}: {
  value: string[]
  onChange: (next: string[]) => void
  connectors: Record<string, ConnectorStatus>
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SYNC_CHANNELS.map((channel) => {
        const on = value.includes(channel)
        const connector = connectors[providerForChannel(channel)]
        const live = connector?.status === 'connected'
        return (
          <button
            key={channel}
            type="button"
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((c) => c !== channel) : [...value, channel])}
            title={
              connector
                ? `Pushed through ${connector.displayName} (${connector.status})`
                : 'No connector configured for this channel'
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              on
                ? 'border-brand-500 bg-brand-50 text-brand-700'
                : 'border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink',
            )}
          >
            {on ? <Check className="h-3 w-3" /> : <span className="h-3 w-3 rounded-sm border border-current opacity-40" />}
            {channelLabel(channel)}
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                live ? 'bg-ok-fg' : connector?.status === 'degraded' ? 'bg-warn-fg' : 'bg-ink-faint',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

/** The card on the detail page: where this segment lands, and a push button. */
export function SyncPanel({
  segmentId,
  syncTargets,
  connectors,
  memberCount,
  canSync,
}: {
  segmentId: string
  syncTargets: string[]
  connectors: Record<string, ConnectorStatus>
  memberCount: number
  canSync: boolean
}) {
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  const [lastResult, setLastResult] = React.useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      const res = await syncSegmentAction(segmentId)
      setLastResult(res.message)
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Pushed to connected channels' : 'Sync did not run',
        body: res.message,
      })
    } catch {
      setLastResult('The push failed before any channel accepted the audience.')
      toast.push({
        tone: 'danger',
        title: 'Sync failed',
        body: 'Nothing was delivered. The attempt is recorded in the audit trail.',
      })
    } finally {
      setBusy(false)
    }
  }

  const blocked = syncTargets.length === 0

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Channel sync"
        description="Membership is pushed as hashed identifiers. Match rates below 100% are the platform's, not a data problem."
        icon={<PlugZap className="h-4 w-4" />}
        actions={
          <Button
            size="xs"
            variant="secondary"
            onClick={run}
            loading={busy}
            disabled={blocked || !canSync || memberCount === 0}
            title={
              blocked
                ? 'Add at least one sync target first'
                : !canSync
                  ? 'Your role cannot sync segments'
                  : undefined
            }
          >
            <Upload className="h-3 w-3" />
            Sync now
          </Button>
        }
      />
      {blocked ? (
        <p className="px-5 py-6 text-center text-[13px] leading-relaxed text-ink-faint">
          This segment has no sync targets. Pick the channels it should be pushed to and save — nothing
          leaves GenAI until you do.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {syncTargets.map((channel) => {
            const connector = connectors[providerForChannel(channel)]
            const tone =
              connector?.status === 'connected'
                ? 'ok'
                : connector?.status === 'degraded'
                  ? 'warn'
                  : 'danger'
            return (
              <li key={channel} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ChannelChip channel={channel} size="sm" />
                  <span className="truncate text-xs text-ink-faint">
                    via {connector?.displayName ?? 'no connector'}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {connector?.lastSyncAt && (
                    <span className="hidden text-2xs text-ink-faint sm:block">
                      <RelativeTime date={connector.lastSyncAt} />
                    </span>
                  )}
                  <Badge tone={tone} dot>
                    {connector?.status ?? 'missing'}
                  </Badge>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {lastResult && (
        <p className="border-t border-line bg-bg-subtle px-5 py-2.5 text-xs leading-relaxed text-ink-muted">
          {lastResult}
        </p>
      )}

      {!blocked && Object.values(connectors).some((c) => syncTargets.some((t) => providerForChannel(t) === c.provider) && c.status !== 'connected') && (
        <p className="flex items-start gap-1.5 border-t border-line px-5 py-2.5 text-xs leading-relaxed text-warn-fg">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          One of these connectors is not healthy. The push will be attempted and the outcome recorded
          in the audit trail either way.
        </p>
      )}
    </Card>
  )
}

/**
 * Recompute membership from the rules. Deliberately not offered for lookalike
 * segments: their rule set is empty, so a refresh would match the entire
 * workspace and destroy the audience.
 */
export function RefreshButton({
  segmentId,
  label = 'Refresh',
  size = 'xs',
  variant = 'ghost',
}: {
  segmentId: string
  label?: string
  size?: 'xs' | 'sm'
  variant?: 'ghost' | 'secondary'
}) {
  const toast = useToast()
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      size={size}
      variant={variant}
      loading={busy}
      onClick={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        setBusy(true)
        try {
          const res = await refreshSegmentAction(segmentId)
          toast.push({
            tone: res.ok ? 'ok' : 'danger',
            title: res.ok ? 'Segment recomputed' : 'Refresh failed',
            body: res.message,
          })
          router.refresh()
        } catch {
          toast.push({
            tone: 'danger',
            title: 'Refresh failed',
            body: 'Membership was left as it was. The stored counts are still the last good ones.',
          })
        } finally {
          setBusy(false)
        }
      }}
    >
      {!busy && <RefreshCw className="h-3 w-3" />}
      {label}
    </Button>
  )
}
