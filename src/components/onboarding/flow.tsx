'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  CircleAlert,
  PenLine,
  SlidersHorizontal,
  Sparkles,
  Users,
} from 'lucide-react'
import type { ScoreDetail } from '@/lib/db/schema'
import { Badge, Button, Field, LinkButton, ScoreRing, Select, Textarea } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import { scoreFirstDraftAction } from './actions'

/* -------------------------------------------------------------------- types */

export type OnboardingBrand = {
  name: string
  voice: string
  doList: string[]
  dontList: string[]
  bannedTerms: string[]
  passThreshold: number
  readingLevelMax: number
  tone: { formal: number; playful: number; technical: number; urgent: number; warm: number }
}

export type OnboardingChain = {
  name: string
  description: string | null
  steps: { name: string; role: string; slaHours?: number }[]
}

export type OnboardingData = {
  firstName: string
  workspaceName: string
  trialDaysLeft: number | null
  brand: OnboardingBrand
  chain: OnboardingChain | null
  legalRuleCount: number
}

const STEPS = ['Your workspace', 'Brand voice', 'First draft', 'Ready'] as const

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'x', label: 'X' },
  { value: 'blog', label: 'Blog' },
] as const

const EXAMPLE = {
  subject: 'Your Q3 pipeline review is ready',
  body: 'We pulled together what changed in your pipeline over the last quarter: where deals stalled, which sources actually converted, and the two segments that outperformed the rest. It takes about four minutes to read and it is specific to your account.',
  cta: 'Read the review',
}

/* --------------------------------------------------------------------- flow */

export function OnboardingFlow({ data }: { data: OnboardingData }) {
  const [step, setStep] = React.useState(0)

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Progress step={step} onJump={setStep} />

      <div className="mt-7 rounded-panel border border-line bg-surface shadow-card">
        {step === 0 && <StepWorkspace data={data} />}
        {step === 1 && <StepBrand brand={data.brand} legalRuleCount={data.legalRuleCount} />}
        {step === 2 && <StepDraft brand={data.brand} />}
        {step === 3 && <StepReady firstName={data.firstName} />}

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line bg-bg-subtle px-5 py-3.5 sm:px-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>

          {step < STEPS.length - 1 ? (
            <div className="flex items-center gap-2">
              <Link
                href="/command-center"
                className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-faint transition-colors hover:text-ink"
              >
                Skip for now
              </Link>
              <Button variant="primary" size="sm" onClick={() => setStep((s) => s + 1)}>
                Continue
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <LinkButton href="/command-center" variant="primary" size="sm">
              Go to Command Center
              <ArrowRight className="h-3.5 w-3.5" />
            </LinkButton>
          )}
        </div>
      </div>
    </div>
  )
}

function Progress({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3">
      {STEPS.map((label, i) => {
        const done = i < step
        const active = i === step
        return (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-2">
            <button
              onClick={() => i <= step && onJump(i)}
              disabled={i > step}
              className={cn(
                'h-1 w-full rounded-full transition-colors',
                done || active ? 'bg-brand-500' : 'bg-bg-inset',
                i <= step ? 'cursor-pointer' : 'cursor-default',
              )}
              aria-label={`Step ${i + 1}: ${label}`}
              aria-current={active ? 'step' : undefined}
            />
            <span
              className={cn(
                'truncate text-2xs font-semibold uppercase tracking-wider',
                active ? 'text-ink' : done ? 'text-ink-muted' : 'text-ink-faint',
              )}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function StepBody({
  title,
  lede,
  children,
}: {
  title: string
  lede: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="px-5 py-6 sm:px-6 sm:py-7">
      <h2 className="text-xl font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted">{lede}</p>
      <div className="mt-6">{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ step 1 */

function StepWorkspace({ data }: { data: OnboardingData }) {
  const stageCopy = [
    ['Generate', 'A brief becomes on-brand variants for each channel.'],
    ['Review', 'Guardrails score the work before anyone reads it.'],
    ['Approve', 'The right people sign off; the decision is logged.'],
    ['Publish', 'One calendar across every connected channel.'],
    ['Monitor', 'Results come back and become the next brief.'],
  ]

  return (
    <StepBody
      title={`${data.workspaceName} is ready to govern work`}
      lede={
        <>
          Two things were created with your workspace, so nothing has to be published unchecked
          {data.trialDaysLeft !== null && (
            <>
              {' '}
              — and you have <span className="font-medium text-ink">{data.trialDaysLeft} days</span> left
              on the trial
            </>
          )}
          .
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-card border border-line bg-bg-subtle p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ok-bg text-ok-fg">
              <Check className="h-3 w-3" strokeWidth={3.5} />
            </span>
            <h3 className="text-[13.5px] font-semibold text-ink">A brand voice profile</h3>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            &ldquo;{data.brand.name}&rdquo; — every generated asset is scored against it and must reach{' '}
            <span className="tnum font-medium text-ink">{data.brand.passThreshold}</span> before it
            reaches a reviewer.
          </p>
        </div>

        <div className="rounded-card border border-line bg-bg-subtle p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ok-bg text-ok-fg">
              <Check className="h-3 w-3" strokeWidth={3.5} />
            </span>
            <h3 className="text-[13.5px] font-semibold text-ink">An approval chain</h3>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            {data.chain
              ? `“${data.chain.name}” — ${data.chain.description ?? `${data.chain.steps.length} step before anything can be scheduled.`}`
              : 'No chain is configured yet. Add one in Settings before scheduling work.'}
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-card border border-line p-4">
        <p className="label">What happens to every piece of work</p>
        <ol className="mt-3 space-y-2">
          {stageCopy.map(([name, note], i) => (
            <li key={name} className="flex items-start gap-3">
              <span className="tnum mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-2xs font-semibold text-brand-700">
                {i + 1}
              </span>
              <span className="min-w-0 text-[13px] leading-relaxed text-ink-muted">
                <span className="font-medium text-ink">{name}</span> — {note}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </StepBody>
  )
}

/* ------------------------------------------------------------------ step 2 */

const TONE_LABELS: { key: keyof OnboardingBrand['tone']; label: string }[] = [
  { key: 'formal', label: 'Formal' },
  { key: 'playful', label: 'Playful' },
  { key: 'technical', label: 'Technical' },
  { key: 'urgent', label: 'Urgent' },
  { key: 'warm', label: 'Warm' },
]

function StepBrand({ brand, legalRuleCount }: { brand: OnboardingBrand; legalRuleCount: number }) {
  return (
    <StepBody
      title="Confirm how you want to sound"
      lede="This is the profile every asset is measured against. The defaults are a sensible starting point — read them, and change anything that is not you."
    >
      <div className="rounded-card border border-line bg-bg-subtle p-4">
        <p className="label">Voice</p>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{brand.voice}</p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-card border border-line p-4">
          <p className="label">Always</p>
          <ul className="mt-2 space-y-1.5">
            {brand.doList.map((d) => (
              <li key={d} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok-fg" strokeWidth={3} />
                {d}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-card border border-line p-4">
          <p className="label">Never</p>
          <ul className="mt-2 space-y-1.5">
            {brand.dontList.map((d) => (
              <li key={d} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" />
                {d}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-4 rounded-card border border-line p-4">
        <p className="label">Tone targets</p>
        <div className="mt-3 space-y-2.5">
          {TONE_LABELS.map((t) => (
            <div key={t.key} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[13px] text-ink-muted">{t.label}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                <span
                  className="block h-full rounded-full bg-brand-500"
                  style={{ width: `${brand.tone[t.key]}%` }}
                />
              </span>
              <span className="tnum w-8 shrink-0 text-right text-xs font-semibold text-ink">
                {brand.tone[t.key]}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Pass threshold {brand.passThreshold}</Badge>
        <Badge tone="neutral">Reading grade ≤ {brand.readingLevelMax}</Badge>
        <Badge tone="danger">{brand.bannedTerms.length} banned terms</Badge>
        <Badge tone={legalRuleCount > 0 ? 'info' : 'neutral'}>
          {legalRuleCount} legal {legalRuleCount === 1 ? 'rule' : 'rules'}
        </Badge>
      </div>

      {brand.bannedTerms.length > 0 && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
          Anything containing{' '}
          {brand.bannedTerms.map((t, i) => (
            <React.Fragment key={t}>
              {i > 0 && ', '}
              <code className="rounded bg-bg-inset px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
                {t}
              </code>
            </React.Fragment>
          ))}{' '}
          is flagged before a reviewer sees it.
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <LinkButton href="/settings/brand" variant="secondary" size="sm">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Edit the full profile
        </LinkButton>
        <p className="text-[13px] text-ink-faint">
          You can change any of this later without losing the audit history.
        </p>
      </div>
    </StepBody>
  )
}

/* ------------------------------------------------------------------ step 3 */

function StepDraft({ brand }: { brand: OnboardingBrand }) {
  const [channel, setChannel] = React.useState<string>('email')
  const [subject, setSubject] = React.useState('')
  const [body, setBody] = React.useState('')
  const [cta, setCta] = React.useState('')
  const [result, setResult] = React.useState<ScoreDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  const run = () => {
    setError(null)
    startTransition(async () => {
      const res = await scoreFirstDraftAction({ channel, subject, body, cta })
      if (res.ok) {
        setResult(res.detail)
      } else {
        setResult(null)
        setError(res.error)
      }
    })
  }

  return (
    <StepBody
      title="Write one draft and watch the check run"
      lede="Nothing here is saved. This is the same deterministic guardrail engine the Content Studio runs on every generated variant — seeing it on your own words is the fastest way to understand what governed means."
    >
      <div className="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>

        {channel === 'email' ? (
          <Field label="Subject line" hint="Email subjects are checked against a 60-character limit.">
            <input
              className="field"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What is this email about?"
            />
          </Field>
        ) : (
          <Field label="Call to action" hint="Optional — the line you want the reader to act on.">
            <input
              className="field"
              value={cta}
              onChange={(e) => setCta(e.target.value)}
              placeholder="Read the review"
            />
          </Field>
        )}
      </div>

      <Field className="mt-4" label="Draft">
        <Textarea
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write two or three sentences the way your brand would say them."
        />
      </Field>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="md" loading={pending} disabled={!body.trim()} onClick={run}>
          <Sparkles className="h-3.5 w-3.5" />
          Score this draft
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            setSubject(EXAMPLE.subject)
            setBody(EXAMPLE.body)
            setCta(EXAMPLE.cta)
            setResult(null)
            setError(null)
          }}
        >
          Use an example
        </Button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-danger-fg/25 bg-danger-bg px-3.5 py-2.5 text-[13px] text-danger-fg">
          {error}
        </p>
      )}

      {result && <ScorePanel detail={result} threshold={brand.passThreshold} />}
    </StepBody>
  )
}

function ScorePanel({ detail, threshold }: { detail: ScoreDetail; threshold: number }) {
  const findings = detail.compliance.findings
  return (
    <div className="mt-5 animate-fade-up rounded-card border border-line bg-bg-subtle p-4">
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-3">
          <ScoreRing score={detail.composite} size={56} label="Composite score" />
          <div>
            <p className="text-[13.5px] font-semibold text-ink">
              {detail.passed ? 'Clears your threshold' : 'Below your threshold'}
            </p>
            <p className="text-xs text-ink-muted">
              Composite {detail.composite} against a pass mark of {threshold}
            </p>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-3 gap-x-4 gap-y-2">
          <SubScore label="Brand" value={detail.brand.score} weight="40%" />
          <SubScore label="Compliance" value={detail.compliance.score} weight="45%" />
          <SubScore
            label="Readability"
            value={detail.readability.score}
            weight="15%"
            note={`grade ${detail.readability.grade}`}
          />
        </div>
      </div>

      {(findings.length > 0 || detail.brand.notes.length > 0) && (
        <ul className="mt-4 space-y-2 border-t border-line pt-4">
          {findings.map((f, i) => (
            <li key={`${f.ruleId}-${i}`} className="flex items-start gap-2.5">
              <Badge
                tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'neutral'}
              >
                {f.severity}
              </Badge>
              <span className="min-w-0 text-[13px] leading-relaxed text-ink">
                {f.message}
                {f.remedy && <span className="block text-xs text-ink-muted">{f.remedy}</span>}
              </span>
            </li>
          ))}
          {detail.brand.notes.map((n) => (
            <li key={n} className="flex items-start gap-2.5">
              <Badge tone="info">voice</Badge>
              <span className="min-w-0 text-[13px] leading-relaxed text-ink">{n}</span>
            </li>
          ))}
        </ul>
      )}

      {findings.length === 0 && detail.brand.notes.length === 0 && (
        <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-muted">
          No findings. In the Studio this asset would go straight to a reviewer with the score
          attached.
        </p>
      )}
    </div>
  )
}

function SubScore({
  label,
  value,
  weight,
  note,
}: {
  label: string
  value: number
  weight: string
  note?: string
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-2xs font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum mt-1 text-lg font-semibold leading-none text-ink">{value}</p>
      <p className="mt-1.5 text-xs leading-snug text-ink-faint">
        {weight} of composite
        {note && <span className="block">{note}</span>}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ step 4 */

function StepReady({ firstName }: { firstName: string }) {
  const next = [
    {
      icon: PenLine,
      title: 'Generate your first real asset',
      body: 'Give the Studio a brief and it produces scored variants per channel, ready to submit for review.',
      href: '/studio/new',
      cta: 'Open the Studio',
    },
    {
      icon: Users,
      title: 'Add the people who sign off',
      body: 'Invite a reviewer so the approval chain has someone in it, and the gate stops being theoretical.',
      href: '/settings',
      cta: 'Invite your team',
    },
    {
      icon: BarChart3,
      title: 'Watch the loop close',
      body: 'The Command Center shows what is in flight, what needs you, and what the results are feeding back.',
      href: '/command-center',
      cta: 'Command Center',
    },
  ]

  return (
    <StepBody
      title={`That is the loop, ${firstName}`}
      lede="You have a voice profile, a gate and a working guardrail check. Three things worth doing next — none of them takes long."
    >
      <ul className="space-y-3">
        {next.map((n) => (
          <li
            key={n.title}
            className="flex flex-col gap-3 rounded-card border border-line p-4 sm:flex-row sm:items-center"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <n.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-semibold text-ink">{n.title}</h3>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{n.body}</p>
            </div>
            <LinkButton href={n.href} variant="secondary" size="sm" className="shrink-0">
              {n.cta}
              <ArrowRight className="h-3.5 w-3.5" />
            </LinkButton>
          </li>
        ))}
      </ul>
    </StepBody>
  )
}
