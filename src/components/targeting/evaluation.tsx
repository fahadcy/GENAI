'use client'

import * as React from 'react'
import { Lock, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SegmentRuleGroup } from '@/lib/db/schema'
import type { EvaluationResult } from '@/lib/targeting/engine'
import { evaluateRulesAction } from '@/app/actions/targeting'
import { Badge, Card, CardHeader, Spinner } from '@/components/ui/primitives'
import { ChannelChip, formatPercent } from '@/components/domain'
import { CHANNEL_CONSENT_LABEL, LIFECYCLE_TONE, PREVIEW_CHANNELS, titleCase } from './shared'

/**
 * AT-3: size, reachability and predicted conversion recompute against the real
 * contact table as the rules change. Debounced so a dropdown drag does not fire
 * a query per keystroke, and stale responses are dropped by request id.
 */
export function useLiveEvaluation(
  rules: SegmentRuleGroup,
  initial: EvaluationResult | null,
  /** Off for segments whose membership is materialised rather than derived. */
  enabled = true,
) {
  const [result, setResult] = React.useState<EvaluationResult | null>(initial)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const key = JSON.stringify(rules)
  const settledKey = React.useRef(initial ? key : null)
  const reqId = React.useRef(0)

  React.useEffect(() => {
    if (!enabled || settledKey.current === key) return
    const id = ++reqId.current
    setPending(true)
    const timer = setTimeout(async () => {
      try {
        const next = await evaluateRulesAction(JSON.parse(key) as SegmentRuleGroup)
        if (reqId.current !== id) return
        settledKey.current = key
        setResult(next)
        setError(null)
      } catch {
        if (reqId.current === id) setError('Could not size this audience. Check the rule values.')
      } finally {
        if (reqId.current === id) setPending(false)
      }
    }, 450)
    return () => clearTimeout(timer)
  }, [key, enabled])

  return { result, pending, error }
}

/* -------------------------------------------------------------- headline */

/** The three numbers AT-3 asks for, whatever produced them. */
export type SizeFigures = Pick<EvaluationResult, 'matched' | 'reachable' | 'predictedConversion'>

export function SizeHeadline({
  result,
  pending,
  compact,
}: {
  result: SizeFigures | null
  pending?: boolean
  compact?: boolean
}) {
  const expected = result ? Math.round(result.reachable * result.predictedConversion) : 0
  return (
    <div className={cn('grid grid-cols-3 gap-4', compact ? 'p-4' : 'p-5')}>
      <Figure
        label="Est. size"
        value={result ? result.matched.toLocaleString('en-GB') : '—'}
        hint="rule matches"
        pending={pending}
      />
      <Figure
        label="Reachable"
        value={result ? result.reachable.toLocaleString('en-GB') : '—'}
        hint="after consent"
        pending={pending}
        tone="ok"
      />
      <Figure
        label="Conv. rate"
        value={result ? formatPercent(result.predictedConversion, 2) : '—'}
        hint={result ? `predicted · ≈ ${expected.toLocaleString('en-GB')}` : 'predicted'}
        pending={pending}
      />
    </div>
  )
}

function Figure({
  label,
  value,
  hint,
  pending,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint: string
  pending?: boolean
  tone?: 'neutral' | 'ok'
}) {
  return (
    <div className="min-w-0">
      {/* Labels stay on one line so the three numbers share a baseline even in
          the 360px side rail. */}
      <p className="label whitespace-nowrap">{label}</p>
      <p
        className={cn(
          'tnum mt-1.5 flex items-center gap-2 text-2xl font-semibold leading-none tracking-tight',
          tone === 'ok' ? 'text-ok-fg' : 'text-ink',
          pending && 'opacity-45',
        )}
      >
        {value}
        {pending && <Spinner className="h-3.5 w-3.5 text-ink-faint" />}
      </p>
      <p className="mt-1.5 text-2xs leading-snug text-ink-faint">{hint}</p>
    </div>
  )
}

/* ---------------------------------------------------------- reachability */

export function ReachabilityBreakdown({
  reachability,
  matched,
  syncTargets,
  channels = [...PREVIEW_CHANNELS],
}: {
  reachability: Record<string, number>
  matched: number
  syncTargets?: string[]
  channels?: string[]
}) {
  const list = channels.filter((c) => c in reachability)
  if (list.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-ink-faint">No channel reachability recorded yet.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {list.map((channel) => {
        const n = reachability[channel] ?? 0
        const share = matched > 0 ? n / matched : 0
        const targeted = !syncTargets || syncTargets.includes(channel)
        return (
          <li key={channel} className="px-5 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <ChannelChip channel={channel} size="sm" />
                {syncTargets && !targeted && (
                  <span className="hidden text-2xs text-ink-faint sm:inline">not synced</span>
                )}
              </div>
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="tnum text-[13px] font-semibold text-ink">{n.toLocaleString('en-GB')}</span>
                <span className="tnum text-2xs text-ink-faint">{formatPercent(share, 0)}</span>
              </div>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-inset">
              <div
                className={cn('h-full rounded-full transition-all', targeted ? 'bg-brand-500' : 'bg-line-strong')}
                style={{ width: `${Math.min(100, share * 100)}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* -------------------------------------------------- consent + suppression */

/**
 * AT-5. The gap between "matched" and "reachable" is the whole governance
 * story, so it is stated in numbers rather than implied, and the control that
 * would switch it off is shown locked open rather than omitted.
 */
export function ConsentPanel({
  matched,
  suppressed,
  reachability,
  suppressionReasons,
  className,
}: {
  matched: number
  suppressed: number
  reachability: Record<string, number>
  suppressionReasons?: { reason: string; count: number }[]
  className?: string
}) {
  const eligible = Math.max(0, matched - suppressed)
  const channels = Object.keys(reachability)
  const worstGap = channels
    .map((c) => ({ channel: c, withheld: Math.max(0, eligible - (reachability[c] ?? 0)) }))
    .sort((a, b) => b.withheld - a.withheld)

  return (
    <Card className={cn('overflow-hidden border-ok-fg/25', className)}>
      <div className="flex items-start gap-3 border-b border-line bg-ok-bg/60 px-5 py-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok-fg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Consent and suppression are enforced</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
            Applied inside the segment engine, on every evaluation and every sync — not at the point
            of send, and not as a setting.
          </p>
        </div>
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-surface px-2 py-1 text-2xs font-semibold text-ok-fg ring-1 ring-inset ring-ok-fg/25"
          title="This cannot be turned off"
        >
          <Lock className="h-3 w-3" />
          Always on
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 px-5 py-4">
        <div>
          <p className="label">Suppressed and excluded</p>
          <p className="tnum mt-1 text-xl font-semibold tracking-tight text-ink">
            {suppressed.toLocaleString('en-GB')}
          </p>
          <p className="mt-1 text-xs leading-snug text-ink-faint">
            {matched > 0
              ? `${formatPercent(suppressed / matched, 1)} of matched contacts. Removed before membership is written, so nothing downstream can reach them.`
              : 'Nothing matched, so nothing was excluded.'}
          </p>
        </div>
        <div>
          <p className="label">Consent withheld</p>
          <p className="tnum mt-1 text-xl font-semibold tracking-tight text-ink">
            {worstGap.length > 0 ? worstGap[0].withheld.toLocaleString('en-GB') : '—'}
          </p>
          <p className="mt-1 text-xs leading-snug text-ink-faint">
            {worstGap.length > 0
              ? `on ${CHANNEL_CONSENT_LABEL[worstGap[0].channel] ?? worstGap[0].channel}, the channel that loses the most. Every channel is gated separately.`
              : 'No channels evaluated yet.'}
          </p>
        </div>
      </div>

      {worstGap.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {worstGap.map(({ channel, withheld }) => (
            <li key={channel} className="flex items-center justify-between gap-3 px-5 py-2">
              <span className="text-[13px] text-ink-muted">
                {CHANNEL_CONSENT_LABEL[channel] ?? channel} missing
              </span>
              <span className="tnum text-[13px] font-medium text-ink">
                −{withheld.toLocaleString('en-GB')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {suppressionReasons && suppressionReasons.length > 0 && (
        <div className="border-t border-line px-5 py-3.5">
          <p className="label">Why contacts are suppressed workspace-wide</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {suppressionReasons.map((r) => (
              <li key={r.reason}>
                <Badge tone="neutral">
                  {r.reason} · <span className="tnum">{r.count.toLocaleString('en-GB')}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------- samples */

export type SampleContact = EvaluationResult['sample'][number]

export function SampleTable({
  sample,
  total,
  title = 'Matched contacts',
  description,
}: {
  sample: SampleContact[]
  total: number
  title?: string
  description?: string
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={title}
        description={
          description ??
          `The ${sample.length} most engaged of ${total.toLocaleString('en-GB')} reachable contacts. Suppressed records never appear here.`
        }
      />
      {sample.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-ink-faint">
          Nothing matches these rules yet. Loosen a condition and the sample fills in.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-2 font-semibold">Contact</th>
                <th className="px-3 py-2 font-semibold">Company</th>
                <th className="px-3 py-2 font-semibold">Stage</th>
                <th className="px-5 py-2 text-right font-semibold">Engagement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sample.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-surface-hover">
                  <td className="max-w-[16rem] px-5 py-2">
                    <p className="truncate font-medium text-ink">{c.name ?? c.email}</p>
                    <p className="truncate text-xs text-ink-faint">{c.email}</p>
                  </td>
                  <td className="max-w-[14rem] px-3 py-2">
                    <p className="truncate text-ink-muted">{c.company ?? '—'}</p>
                    {c.jobTitle && <p className="truncate text-xs text-ink-faint">{c.jobTitle}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={LIFECYCLE_TONE[c.lifecycleStage] ?? 'neutral'}>
                      {titleCase(c.lifecycleStage)}
                    </Badge>
                  </td>
                  <td className="px-5 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-bg-inset sm:block">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${Math.min(100, c.engagementScore)}%` }}
                        />
                      </div>
                      <span className="tnum w-7 text-right font-medium text-ink">
                        {Math.round(c.engagementScore)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
