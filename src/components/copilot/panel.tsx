'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  RotateCcw,
  Sparkles,
  TrendingDown,
  Clock,
  Wallet,
  Users,
  Flame,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, EmptyState } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import {
  applyRecommendationAction,
  dismissRecommendationAction,
  refreshCopilotAction,
  revertRecommendationAction,
} from '@/app/actions/copilot'

export type RecommendationView = {
  id: string
  type: string
  title: string
  rationale: string
  evidence: { label: string; value: string }[]
  expectedEffect: { metric: string; delta: string; confidence: number; horizonDays: number }
  priorityScore: number
  status: string
  appliedAt: string | null
}

const TYPE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  creative_fatigue: { icon: Flame, label: 'Creative fatigue' },
  budget_shift: { icon: Wallet, label: 'Budget' },
  send_time: { icon: Clock, label: 'Send time' },
  approval_sla: { icon: TrendingDown, label: 'Bottleneck' },
  segment_expansion: { icon: Users, label: 'Audience' },
}

export function CopilotPanel({
  recommendations,
  applied,
  canApply,
}: {
  recommendations: RecommendationView[]
  applied: RecommendationView[]
  canApply: boolean
}) {
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)
  const { push } = useToast()

  const refresh = async () => {
    setRefreshing(true)
    try {
      const { count } = await refreshCopilotAction()
      push({
        tone: 'info',
        title: count > 0 ? `${count} recommendation${count === 1 ? '' : 's'} found` : 'Nothing to act on',
        body:
          count > 0
            ? 'Re-analysed the last 30 days of performance, approvals and scheduling.'
            : 'Performance, approvals and scheduling all look healthy right now.',
      })
      router.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="card flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-brand-solid text-brand-on">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-ink">Copilot</h2>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
              Findings computed from your own data. Every action is reversible.
            </p>
          </div>
        </div>
        <Button size="xs" variant="ghost" onClick={refresh} loading={refreshing} title="Re-run the analysis">
          {refreshing ? '' : 'Re-analyse'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {recommendations.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title="Nothing needs a decision"
            description="No fatiguing creative, no cost-per-acquisition gaps, no overdue approvals and no send times worth moving."
          />
        ) : (
          <ul className="divide-y divide-line">
            {recommendations.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} canApply={canApply} />
            ))}
          </ul>
        )}
      </div>

      {applied.length > 0 && (
        <div className="border-t border-line bg-bg-subtle px-5 py-3">
          <p className="label mb-2">Recently applied</p>
          <ul className="space-y-1.5">
            {applied.slice(0, 3).map((a) => (
              <AppliedRow key={a.id} rec={a} canApply={canApply} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function RecommendationCard({ rec, canApply }: { rec: RecommendationView; canApply: boolean }) {
  const router = useRouter()
  const { push } = useToast()
  const [busy, setBusy] = React.useState<'apply' | 'dismiss' | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const meta = TYPE_META[rec.type] ?? { icon: Sparkles, label: rec.type }
  const Icon = meta.icon

  const apply = async () => {
    setBusy('apply')
    try {
      const result = await applyRecommendationAction(rec.id)
      push({
        tone: result.ok ? 'ok' : 'danger',
        title: result.ok ? 'Applied' : 'Could not apply',
        body: result.message,
      })
      if (result.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async () => {
    setBusy('dismiss')
    try {
      await dismissRecommendationAction(rec.id)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const confidence = Math.round(rec.expectedEffect.confidence * 100)

  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-inset text-ink-muted">
          <Icon className="h-3.5 w-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold leading-snug text-ink">{rec.title}</h3>
            <button
              onClick={dismiss}
              disabled={busy !== null}
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-ink-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-ink focus:opacity-100 group-hover:opacity-100 md:opacity-60"
              aria-label="Dismiss this recommendation"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <p
            className={cn(
              'mt-1.5 text-[13px] leading-relaxed text-ink-muted',
              !expanded && 'line-clamp-2',
            )}
          >
            {rec.rationale}
          </p>
          {rec.rationale.length > 150 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-brand-600 hover:underline"
            >
              {expanded ? 'Show less' : 'Why this, in full'}
            </button>
          )}

          {expanded && rec.evidence.length > 0 && (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg bg-bg-subtle p-3">
              {rec.evidence.map((e, i) => (
                <div key={i} className="min-w-0">
                  <dt className="truncate text-2xs text-ink-faint">{e.label}</dt>
                  <dd className="tnum truncate text-[13px] font-semibold text-ink">{e.value}</dd>
                </div>
              ))}
            </dl>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="brand">
              {rec.expectedEffect.metric} {rec.expectedEffect.delta}
            </Badge>
            <span className="text-2xs text-ink-faint">
              {confidence}% confidence · {rec.expectedEffect.horizonDays}-day horizon
            </span>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              size="xs"
              variant="primary"
              onClick={apply}
              loading={busy === 'apply'}
              disabled={!canApply || busy !== null}
              title={canApply ? undefined : 'Your role cannot apply copilot actions.'}
            >
              Apply
              <ArrowRight className="h-3 w-3" />
            </Button>
            <span className="text-2xs text-ink-faint">Reversible in one click</span>
          </div>
        </div>
      </div>
    </li>
  )
}

function AppliedRow({ rec, canApply }: { rec: RecommendationView; canApply: boolean }) {
  const router = useRouter()
  const { push } = useToast()
  const [busy, setBusy] = React.useState(false)

  const revert = async () => {
    setBusy(true)
    try {
      const result = await revertRecommendationAction(rec.id)
      push({
        tone: result.ok ? 'ok' : 'danger',
        title: result.ok ? 'Reverted' : 'Could not revert',
        body: result.message,
      })
      if (result.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const reverted = rec.status === 'reverted'

  return (
    <li className="flex items-center justify-between gap-2">
      <span
        className={cn('min-w-0 flex-1 truncate text-xs', reverted ? 'text-ink-faint line-through' : 'text-ink-muted')}
      >
        {rec.title}
      </span>
      {!reverted && canApply && (
        <button
          onClick={revert}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-ink-muted hover:text-brand-600 disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" />
          Undo
        </button>
      )}
    </li>
  )
}

export function CopilotInlineLink() {
  return (
    <Link href="/command-center" className="inline-flex items-center gap-1.5 text-brand-600 hover:underline">
      <Sparkles className="h-3.5 w-3.5" />
      Ask the copilot
    </Link>
  )
}
