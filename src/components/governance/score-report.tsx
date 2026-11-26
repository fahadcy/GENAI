import * as React from 'react'
import { AlertOctagon, AlertTriangle, BookOpen, Check, Info, Palette, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, ProgressBar, ScoreRing } from '@/components/ui/primitives'
import { TONE_AXES } from '@/lib/ai/guardrails'
import type { GuardrailFinding, ScoreDetail, ToneAxis } from '@/lib/db/schema'

/**
 * The guardrail verdict, rendered identically wherever an asset is judged —
 * Content Studio, the approvals queue and the approval detail all use this.
 *
 * That sameness is deliberate: a reviewer must see exactly what the author saw,
 * or "pre-scored before a human looks at it" stops meaning anything.
 */

const SEVERITY: Record<
  GuardrailFinding['severity'],
  { label: string; tone: 'danger' | 'warn' | 'info'; icon: React.ComponentType<{ className?: string }> }
> = {
  high: { label: 'Blocking', tone: 'danger', icon: AlertOctagon },
  medium: { label: 'Should fix', tone: 'warn', icon: AlertTriangle },
  low: { label: 'Suggestion', tone: 'info', icon: Info },
}

export function ScoreReport({
  detail,
  threshold,
  toneTarget,
  compact,
  className,
}: {
  detail: ScoreDetail
  threshold: number
  toneTarget?: ToneAxis
  compact?: boolean
  className?: string
}) {
  const blocking = detail.compliance.findings.filter((f) => f.severity === 'high')
  const others = detail.compliance.findings.filter((f) => f.severity !== 'high')

  return (
    <div className={cn('space-y-4', className)}>
      {/* Verdict */}
      <div
        className={cn(
          'flex items-start gap-3.5 rounded-xl border p-4',
          detail.passed ? 'border-ok-fg/25 bg-ok-bg' : 'border-danger-fg/25 bg-danger-bg',
        )}
      >
        <ScoreRing score={detail.composite} size={46} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13.5px] font-semibold', detail.passed ? 'text-ok-fg' : 'text-danger-fg')}>
            {detail.passed
              ? 'Cleared brand and legal checks'
              : blocking.length > 0
                ? `Blocked by ${blocking.length} rule${blocking.length === 1 ? '' : 's'}`
                : `Below the ${threshold}/100 threshold`}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {detail.passed
              ? `Scored ${detail.composite}/100 against the workspace threshold of ${threshold}. It can go to a reviewer as it stands.`
              : blocking.length > 0
                ? 'A blocking finding stops submission outright, whatever the score. Fix it below and the asset re-scores on save.'
                : `Scored ${detail.composite}/100. Editing or regenerating will re-score it automatically.`}
          </p>
        </div>
      </div>

      {/* Sub-scores */}
      <div className="grid grid-cols-3 gap-3">
        <SubScore
          icon={Palette}
          label="Voice"
          score={detail.brand.score}
          weight="40% of composite"
          hint="Tone distance from the profile, plus do/don't adherence."
        />
        <SubScore
          icon={ShieldCheck}
          label="Legal"
          score={detail.compliance.score}
          weight="45% of composite"
          hint="Legal rules, banned terms, disclaimers, channel limits."
        />
        <SubScore
          icon={BookOpen}
          label="Reading"
          score={detail.readability.score}
          weight={`Grade ${detail.readability.grade.toFixed(1)}`}
          hint="Flesch-Kincaid grade level against the profile's ceiling."
        />
      </div>

      {/* Findings */}
      {detail.compliance.findings.length > 0 ? (
        <div>
          <p className="label mb-2">
            {detail.compliance.findings.length} finding
            {detail.compliance.findings.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-2">
            {[...blocking, ...others].map((f, i) => (
              <FindingRow key={`${f.ruleId}-${i}`} finding={f} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-lg bg-bg-subtle px-3 py-2.5 text-[13px] text-ink-muted">
          <Check className="h-3.5 w-3.5 text-ok-fg" />
          No rule was triggered. Every legal rule, banned term, required disclaimer and channel limit
          passed.
        </p>
      )}

      {/* Tone */}
      {!compact && toneTarget && (
        <div>
          <p className="label mb-2.5">Voice against the profile</p>
          <div className="space-y-2.5">
            {TONE_AXES.map((axis) => {
              const actual = detail.brand.axes[axis] ?? 0
              const target = toneTarget[axis]
              const delta = actual - target
              const off = Math.abs(delta) > 18
              return (
                <div key={axis}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-xs capitalize text-ink">{axis}</span>
                    <span className={cn('tnum text-2xs', off ? 'font-semibold text-warn-fg' : 'text-ink-faint')}>
                      {actual} vs {target} target
                    </span>
                  </div>
                  <div className="relative h-1.5 w-full rounded-full bg-bg-inset">
                    {/* Tolerance band the guardrail allows before it costs score. */}
                    <div
                      className="absolute inset-y-0 rounded-full bg-brand-100"
                      style={{
                        left: `${Math.max(0, target - 12)}%`,
                        width: `${Math.min(100, target + 12) - Math.max(0, target - 12)}%`,
                      }}
                    />
                    <div
                      className={cn(
                        'absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
                        off ? 'bg-warn-fg' : 'bg-brand-600',
                      )}
                      style={{ left: `${actual}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          {detail.brand.notes.length > 0 && (
            <ul className="mt-3 space-y-1">
              {detail.brand.notes.map((n, i) => (
                <li key={i} className="text-xs leading-relaxed text-ink-muted">
                  · {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function SubScore({
  icon: Icon,
  label,
  score,
  weight,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  score: number
  weight: string
  hint: string
}) {
  const tone = score >= 85 ? 'ok' : score >= 70 ? 'warn' : 'danger'
  return (
    <div className="rounded-lg border border-line p-3" title={hint}>
      <div className="flex items-center gap-1.5 text-ink-faint">
        <Icon className="h-3 w-3" />
        <span className="truncate text-2xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="tnum mt-1.5 text-lg font-semibold leading-none text-ink">{score}</p>
      <ProgressBar value={score} tone={tone} className="mt-2" />
      <p className="mt-1.5 truncate text-2xs text-ink-faint">{weight}</p>
    </div>
  )
}

function FindingRow({ finding }: { finding: GuardrailFinding }) {
  const meta = SEVERITY[finding.severity]
  const Icon = meta.icon
  return (
    <li
      className={cn(
        'rounded-lg border p-3',
        finding.severity === 'high' ? 'border-danger-fg/25 bg-danger-bg/40' : 'border-line',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0',
            finding.severity === 'high'
              ? 'text-danger-fg'
              : finding.severity === 'medium'
                ? 'text-warn-fg'
                : 'text-info-fg',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">{finding.ruleName}</span>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{finding.message}</p>
          {finding.excerpt && (
            <p className="mt-1.5 inline-block rounded bg-bg-inset px-1.5 py-0.5 font-mono text-2xs text-ink">
              “{finding.excerpt}”
            </p>
          )}
          {finding.remedy && (
            <p className="mt-1.5 text-xs text-ink-faint">
              <span className="font-medium">Fix:</span> {finding.remedy}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

/** One-line verdict for dense lists. */
export function ScoreChip({ detail, size = 30 }: { detail: ScoreDetail | null; size?: number }) {
  if (!detail) return <span className="text-xs text-ink-faint">—</span>
  const blocking = detail.compliance.findings.filter((f) => f.severity === 'high').length
  return (
    <span className="inline-flex items-center gap-2" title={detail.passed ? 'Passed' : 'Not passed'}>
      <ScoreRing score={detail.composite} size={size} />
      {blocking > 0 && (
        <Badge tone="danger" dot>
          {blocking} blocking
        </Badge>
      )}
    </span>
  )
}
