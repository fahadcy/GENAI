import Link from 'next/link'
import { MapPin } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AdCampaignStatus, AdObjective } from '@/lib/db/schema'
import { objectiveDef, MONTHLY_BUDGET_MULTIPLIER } from '@/lib/ads/objectives'
import { Badge, type BadgeTone } from '@/components/ui/primitives'
import { RelativeTime, formatMoney } from '@/components/domain'

/**
 * Status in the words of someone who has never opened Google Ads.
 *
 * The enum values are internal shorthand; what a reader needs to know is
 * whether the campaign is costing them money, waiting on a person, or stuck.
 * "Approved — not sent yet" is spelled out because approving a campaign feels
 * like launching one, and it is not.
 */
const STATUS_META: Record<AdCampaignStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  in_review: { label: 'Waiting for approval', tone: 'warn' },
  changes_requested: { label: 'Changes requested', tone: 'danger' },
  approved: { label: 'Approved — not sent yet', tone: 'brand' },
  publishing: { label: 'Sending to Google', tone: 'neutral' },
  live: { label: 'Running', tone: 'ok' },
  paused: { label: 'In Google, paused', tone: 'neutral' },
  ended: { label: 'Finished', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
}

export function AdStatusBadge({ status }: { status: AdCampaignStatus }) {
  const meta = STATUS_META[status]
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  )
}

export type AdCampaignRow = {
  id: string
  name: string
  status: AdCampaignStatus
  objective: AdObjective
  dailyBudgetMicros: number
  currencyCode: string
  geoTargets: { criterionId: string; name: string }[]
  adGroupCount: number
  keywordCount: number
  updatedAt: Date
}

export function CampaignList({ campaigns }: { campaigns: AdCampaignRow[] }) {
  return (
    <ul className="divide-y divide-line">
      {campaigns.map((c) => (
        <li key={c.id}>
          <Row campaign={c} />
        </li>
      ))}
    </ul>
  )
}

function Row({ campaign: c }: { campaign: AdCampaignRow }) {
  const objective = objectiveDef(c.objective)
  const daily = c.dailyBudgetMicros / 1_000_000
  const monthly = daily * MONTHLY_BUDGET_MULTIPLIER
  // Only a running campaign is actually taking money, so only a running row
  // gets to shout its monthly figure.
  const spending = c.status === 'live'
  const places = c.geoTargets.map((g) => g.name)

  return (
    <Link
      href={`/ads/${c.id}`}
      className="block px-5 py-4 transition-colors hover:bg-surface-hover"
    >
      {/* The name gets the full width on a phone and the money moves under it.
          Sharing one line there would squeeze the name to three characters,
          which is the one thing on this row nobody can guess from context. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="w-full min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">{c.name}</span>
            <AdStatusBadge status={c.status} />
          </div>
          <p className="mt-1 text-[13px] leading-snug text-ink-muted">{objective.label}</p>
        </div>

        <div className="min-w-0 shrink-0 text-left sm:text-right">
          <p className="tnum text-[13px] text-ink">
            {formatMoney(daily, c.currencyCode)}
            <span className="text-ink-faint"> a day</span>
          </p>
          <p
            className={cn(
              'tnum mt-0.5 text-xs',
              spending ? 'font-semibold text-ink' : 'text-ink-faint',
            )}
          >
            {spending ? 'spending up to ' : 'would spend up to '}
            {formatMoney(monthly, c.currencyCode)} a month
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-ink-faint">
        <span className="tnum">
          {c.adGroupCount} ad group{c.adGroupCount === 1 ? '' : 's'} · {c.keywordCount} keyword
          {c.keywordCount === 1 ? '' : 's'}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <MapPin className="h-3 w-3 shrink-0" />
          <span className="truncate" title={places.join(', ')}>
            {places.length === 0
              ? 'nowhere chosen yet'
              : places.length <= 2
                ? places.join(' and ')
                : `${places.slice(0, 2).join(', ')} and ${places.length - 2} more`}
          </span>
        </span>
        <span className="ml-auto shrink-0">
          updated <RelativeTime date={c.updatedAt} />
        </span>
      </div>
    </Link>
  )
}
