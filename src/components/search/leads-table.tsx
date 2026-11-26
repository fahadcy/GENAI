'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/cn'
import { LEAD_CATEGORY_LABEL, NOT_A_PROSPECT, type LeadCategory, type LeadOutcome } from '@/lib/serptwin'
import { updateLeadOutcomeAction } from '@/app/actions/search'
import { Badge, Button, Card, type BadgeTone } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

export type LeadRowView = {
  id: string
  externalId: string
  receivedAt: string
  /** Pre-formatted on the server so server and browser render the same text. */
  when: string
  source: string
  searchTerm: string | null
  message: string
  location: string | null
  outcome: string
  lostReason: string | null
  contactAttempts: number
  respondedAt: string | null
  simulated: boolean
  category: LeadCategory | null
  evidence: string[]
  service: string | null
  /** Outcome changed since the last analysis, so the category shown is out of date. */
  stale: boolean
}

const OUTCOMES: { value: LeadOutcome; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'unqualified', label: 'Not suitable' },
  { value: 'spam', label: 'Spam' },
]

function tone(c: LeadCategory | null): BadgeTone {
  if (!c) return 'neutral'
  if (c === 'won') return 'ok'
  if (NOT_A_PROSPECT.has(c)) return 'danger'
  if (c === 'missed_follow_up') return 'warn'
  if (c === 'unreachable' || c === 'open') return 'neutral'
  return 'info'
}

const FILTERS: { value: string; label: string; test: (r: LeadRowView) => boolean }[] = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'junk', label: 'Not real prospects', test: (r) => !!r.category && NOT_A_PROSPECT.has(r.category) },
  { value: 'missed', label: 'Not followed up', test: (r) => r.category === 'missed_follow_up' },
  { value: 'open', label: 'Needs an outcome', test: (r) => r.outcome === 'open' },
  { value: 'won', label: 'Won', test: (r) => r.category === 'won' },
]

export function LeadsTable({
  rows,
  canEdit,
  total,
}: {
  rows: LeadRowView[]
  canEdit: boolean
  total: number
}) {
  const [filter, setFilter] = React.useState('open')
  const f = FILTERS.find((x) => x.value === filter)!
  const shown = rows.filter(f.test)
  const simulated = rows.some((r) => r.simulated)
  return (
    <div className="space-y-3">
      {simulated && (
        <p className="rounded-lg border border-warn-fg/25 bg-warn-bg px-3 py-2 text-[13px] text-ink">
          These are example enquiries from the simulator. Outcomes you set here are real inputs to the next
          analysis, so you can see how it responds.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((x) => (
          <button
            key={x.value}
            type="button"
            aria-pressed={filter === x.value}
            onClick={() => setFilter(x.value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium',
              filter === x.value
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-line bg-surface text-ink-muted',
            )}
          >
            {x.label} <span className="tnum text-ink-faint">{rows.filter(x.test).length}</span>
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-faint">
          Showing the latest {rows.length} of {total}
        </span>
      </div>
      <Card className="divide-y divide-line">
        {shown.length === 0 && <p className="px-4 py-6 text-[13px] text-ink-faint">Nothing here.</p>}
        {shown.slice(0, 150).map((r) => (
          <LeadRow key={r.id} row={r} canEdit={canEdit} />
        ))}
      </Card>
    </div>
  )
}

function LeadRow({ row, canEdit }: { row: LeadRowView; canEdit: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [outcome, setOutcome] = React.useState(row.outcome as LeadOutcome)
  const [reason, setReason] = React.useState(row.lostReason ?? '')
  const [attempts, setAttempts] = React.useState(row.contactAttempts)
  const [busy, setBusy] = React.useState(false)
  const dirty =
    outcome !== row.outcome || reason !== (row.lostReason ?? '') || attempts !== row.contactAttempts
  const needsReason = outcome === 'lost' || outcome === 'unqualified'

  const save = async () => {
    setBusy(true)
    try {
      const res = await updateLeadOutcomeAction({
        leadId: row.id,
        outcome,
        lostReason: needsReason ? reason : null,
        contactAttempts: attempts,
      })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Outcome saved' : 'Not saved',
        body: res.message,
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const when = row.when
  return (
    <div className="grid gap-3 px-4 py-3 text-[13px] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
          <span className="font-mono">{row.externalId}</span>
          <span>{when}</span>
          <span>{row.source === 'ppc' ? 'Paid search' : row.source}</span>
          {row.location && <span>{row.location}</span>}
          {row.service && <span>· {row.service}</span>}
        </div>
        {row.searchTerm && <div className="text-xs text-ink-muted">Searched “{row.searchTerm}”</div>}
        <p className="break-words text-ink">{row.message}</p>
      </div>
      <div className="min-w-0 space-y-1">
        {row.category ? (
          <Badge tone={tone(row.category)}>{LEAD_CATEGORY_LABEL[row.category]}</Badge>
        ) : (
          <span className="text-xs text-ink-faint">Not analysed yet</span>
        )}
        {row.stale && <p className="text-2xs text-warn-fg">Outcome changed since the last analysis</p>}
        <ul className="space-y-0.5 text-xs text-ink-muted">
          {row.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`o-${row.id}`}>
            Outcome
          </label>
          <select
            id={`o-${row.id}`}
            value={outcome}
            disabled={!canEdit}
            onChange={(e) => setOutcome(e.target.value as LeadOutcome)}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
          >
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted" htmlFor={`a-${row.id}`}>
            Contact attempts
            <input
              id={`a-${row.id}`}
              type="number"
              min={0}
              max={50}
              value={attempts}
              disabled={!canEdit}
              onChange={(e) => setAttempts(Math.max(0, +e.target.value || 0))}
              className="h-8 w-14 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
            />
          </label>
        </div>
        {needsReason && (
          <>
            <label className="sr-only" htmlFor={`r-${row.id}`}>
              Reason
            </label>
            <input
              id={`r-${row.id}`}
              value={reason}
              disabled={!canEdit}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why, in your own words — e.g. “price didn’t include onboarding”"
              className="h-8 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
            />
          </>
        )}
        {canEdit && dirty && (
          <Button size="xs" variant="primary" loading={busy} onClick={save}>
            Save outcome
          </Button>
        )}
      </div>
    </div>
  )
}
