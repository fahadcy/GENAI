'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, FileText, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  CLAIM_DEFINITION,
  CLAIM_LABEL,
  INTENTS,
  readPauseTest,
  VERDICT_LABEL,
  type Engine,
  type Intent,
  type Recommendation,
  type SerpTwinReport,
} from '@/lib/serptwin'
import { simulatePauseTest } from '@/lib/serptwin/simulator'
import { SERP_LIMITS } from '@/lib/serptwin/pixel'
import { briefHref } from '@/lib/search/brief'
import { submitSearchRecommendationAction } from '@/app/actions/search'
import { Badge, Button, Card, CardHeader, type BadgeTone } from '@/components/ui/primitives'
import { Disclosure, Tabs, useToast } from '@/components/ui/client'
import { formatMoney } from '@/components/domain'
import { BudgetView, LeadQualityView, SeoPrioritiesView } from './business-views'

/**
 * The PPC & SEO workspace. Everything on it is read from one stored report,
 * so every figure is the one the engine produced and the one a reviewer will
 * see. The only thing computed here is the pause-test readout against the
 * simulator, which is pure and writes nothing.
 */

export type ActionState = { id: string; status: string }

const INTENT_LABEL: Record<Intent, string> = {
  transactional: 'Transactional',
  commercial: 'Commercial',
  informational: 'Informational',
  navigational: 'Navigational',
  careers: 'Careers',
  free_seeker: 'Free-seeker',
}
const INTENT_COLOR: Record<Intent, string> = {
  transactional: 'rgb(var(--series-1))',
  commercial: 'rgb(var(--series-2))',
  informational: 'rgb(var(--series-3))',
  navigational: 'rgb(var(--series-4))',
  careers: 'rgb(var(--series-5))',
  free_seeker: 'rgb(var(--series-6))',
}
const PAID = 'rgb(var(--series-2))'
const ORGANIC = 'rgb(var(--series-1))'

const ENGINE_LABEL: Record<Engine, string> = {
  overlap: 'Paid/organic overlap',
  genome: 'Claim Genome',
  transfer: 'Paid → organic',
  drift: 'Intent drift',
  leads: 'Why leads fail',
  capacity: 'Profit & capacity',
  demand: 'SEO from demand',
}
const CONFIDENCE_TONE: Record<Recommendation['confidence'], BadgeTone> = {
  measured: 'ok',
  estimated: 'brand',
  hypothesis: 'warn',
}
const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Not sent', tone: 'neutral' },
  in_review: { label: 'Waiting for approval', tone: 'warn' },
  changes_requested: { label: 'Changes requested', tone: 'danger' },
  approved: { label: 'Approved — not applied', tone: 'brand' },
  applied: { label: 'Applied', tone: 'ok' },
  reverted: { label: 'Reverted', tone: 'neutral' },
}
const VERDICT_TONE: Record<string, BadgeTone> = {
  harvest: 'ok',
  defend: 'brand',
  bridge: 'info',
  gap: 'warn',
  hold: 'neutral',
}

const money = (n: number) => formatMoney(Math.round(n), 'GBP').replace(/\.00$/, '')
const pct = (n: number, dp = 0) => `${n < 0 ? '−' : ''}${Math.abs(n * 100).toFixed(dp)}%`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(0)}%`
const verdictShort = (v: string) => VERDICT_LABEL[v as keyof typeof VERDICT_LABEL].split(' — ')[0]

type Tab = 'queue' | 'leads' | 'budget' | 'seo' | 'ledger' | 'genome' | 'transfer' | 'drift' | 'pause'

export function SearchWorkspace({
  runId,
  report,
  actions,
  canSubmit,
}: {
  runId: string
  report: SerpTwinReport
  actions: Record<string, ActionState>
  canSubmit: boolean
}) {
  const [tab, setTab] = React.useState<Tab>('queue')
  const r = report
  const cards = (engine: Engine) =>
    r.recommendations
      .filter((x) => x.engine === engine)
      .map((rec) => (
        <RecommendationCard
          key={rec.id}
          runId={runId}
          rec={rec}
          action={actions[rec.id]}
          canSubmit={canSubmit}
        />
      ))
  const briefLinks = Object.fromEntries(
    r.recommendations.filter((x) => x.engine === 'demand').map((x) => [x.id, briefHref(x)]),
  )

  return (
    <div className="space-y-5">
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { value: 'queue', label: 'Action queue', count: r.recommendations.length },
          { value: 'leads', label: 'Lead quality', count: r.leads?.total ?? 0 },
          {
            value: 'budget',
            label: 'Budget & capacity',
            count: r.budgets?.filter((p) => p.decision !== 'hold').length ?? 0,
          },
          { value: 'seo', label: 'SEO priorities', count: Math.min(3, r.seo?.length ?? 0) },
          {
            value: 'ledger',
            label: 'Query ledger',
            count: r.verdicts.filter((v) => v.verdict !== 'hold').length,
          },
          {
            value: 'genome',
            label: 'Claim Genome',
            count: r.genome.reduce((a, g) => a + g.effects.length, 0),
          },
          { value: 'transfer', label: 'Paid → organic', count: r.rewrites.length + r.recommendations.filter((x) => x.id.startsWith('tr-dup-')).length },
          { value: 'drift', label: 'Intent drift', count: r.drifts.filter((d) => d.flagged).length },
          { value: 'pause', label: 'Pause test', count: r.pauseTest ? 1 : 0 },
        ]}
      />
      {tab === 'queue' && <Queue runId={runId} report={r} actions={actions} canSubmit={canSubmit} />}
      {tab === 'leads' && <LeadQualityView report={r} recs={cards('leads')} />}
      {tab === 'budget' && <BudgetView report={r} recs={cards('capacity')} />}
      {tab === 'seo' && <SeoPrioritiesView report={r} briefLinks={briefLinks} />}
      {tab === 'ledger' && <Ledger report={r} />}
      {tab === 'genome' && <GenomeView report={r} />}
      {tab === 'transfer' && (
        <TransferView runId={runId} report={r} actions={actions} canSubmit={canSubmit} />
      )}
      {tab === 'drift' && <DriftView report={r} />}
      {tab === 'pause' && <PauseView report={r} />}
    </div>
  )
}

/* ------------------------------------------------------------ Action queue */

function Queue({
  runId,
  report,
  actions,
  canSubmit,
}: {
  runId: string
  report: SerpTwinReport
  actions: Record<string, ActionState>
  canSubmit: boolean
}) {
  const [engine, setEngine] = React.useState<'all' | Engine>('all')
  const list = report.recommendations.filter((x) => engine === 'all' || x.engine === engine)
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Every finding from the four engines, ranked by monthly impact weighted by how it was reached: measured
        spend counts in full, estimates at 70%, hypotheses at 40%. Anything that touches money or a live page
        goes through your approval chain with its undo captured before it can be applied.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(['all', 'leads', 'capacity', 'demand', 'overlap', 'genome', 'transfer', 'drift'] as const).map(
          (e) => (
            <button
              key={e}
              type="button"
              aria-pressed={engine === e}
              onClick={() => setEngine(e)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                engine === e
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-line bg-surface text-ink-muted hover:text-ink',
              )}
            >
              {e === 'all' ? 'All engines' : ENGINE_LABEL[e]}
            </button>
          ),
        )}
      </div>
      <div className="space-y-2.5">
        {list.map((rec) => (
          <RecommendationCard
            key={rec.id}
            runId={runId}
            rec={rec}
            action={actions[rec.id]}
            canSubmit={canSubmit}
          />
        ))}
      </div>
    </div>
  )
}

export function RecommendationCard({
  runId,
  rec,
  action,
  canSubmit,
}: {
  runId: string
  rec: Recommendation
  action?: ActionState
  canSubmit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  const gated = rec.actions.some((a) => a.requiresApproval)
  const brief = briefHref(rec)
  const status = action ? (STATUS_META[action.status] ?? STATUS_META.draft) : null

  const submit = async () => {
    setBusy(true)
    try {
      const res = await submitSearchRecommendationAction(runId, rec.id)
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Sent for approval' : 'Not sent',
        body: res.message,
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-2xs font-semibold uppercase tracking-wide text-brand-700">
              {ENGINE_LABEL[rec.engine]}
            </span>
            <Badge tone={CONFIDENCE_TONE[rec.confidence]}>{rec.confidence}</Badge>
            {status && (
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
            )}
          </div>
          <h3 className="text-[14px] font-semibold leading-snug text-ink">{rec.title}</h3>
        </div>
        <div className="text-right">
          <div className="tnum text-lg font-semibold text-ink">
            {rec.monthlyImpact > 0.5 ? money(rec.monthlyImpact) : '—'}
          </div>
          <div className="text-2xs text-ink-faint">{rec.monthlyImpact > 0.5 ? 'per month' : 'no change'}</div>
        </div>
      </div>
      <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-ink-muted">{rec.summary}</p>

      {rec.actions.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {rec.actions.map((a, i) => (
            <li
              key={i}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-inset px-3 py-2 text-[13px]"
            >
              <span className="min-w-0 flex-1 text-ink">{a.description}</span>
              <span className="flex gap-1.5">
                {a.requiresApproval ? (
                  <Badge tone="brand">Needs approval</Badge>
                ) : (
                  <Badge>No approval needed</Badge>
                )}
                {a.undo && <Badge>Undo captured</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Disclosure summary="Evidence and assumptions" className="mt-3">
        <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-[minmax(160px,max-content)_1fr]">
          {rec.evidence.map((e, i) => (
            <React.Fragment key={i}>
              <dt className="text-ink-faint">{e.label}</dt>
              <dd className="tnum min-w-0 break-words text-ink">{e.value}</dd>
            </React.Fragment>
          ))}
        </dl>
        <ul className="mt-2.5 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-muted">
          {rec.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </Disclosure>

      {(gated || brief) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {gated &&
            (action && action.status !== 'draft' && action.status !== 'changes_requested' ? (
              <Link
                href={`/search/actions/${action.id}`}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline"
              >
                Open the change <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ) : canSubmit ? (
              <Button size="sm" variant="primary" loading={busy} onClick={submit}>
                <ShieldCheck className="h-3.5 w-3.5" /> Send for approval
              </Button>
            ) : (
              <span className="text-xs text-ink-faint">
                Your role can read this but not send it for approval.
              </span>
            ))}
          {brief && (
            <Link
              href={brief}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-hover"
            >
              <FileText className="h-3.5 w-3.5" /> Draft the page in Content Studio
            </Link>
          )}
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------ Query ledger */

function PositionStrip({ pos }: { pos: number | null }) {
  const W = 120
  const x = (p: number) => 4 + ((Math.min(20, p) - 1) / 19) * (W - 8)
  return (
    <svg width={W} height={16} viewBox={`0 0 ${W} 16`} className="inline-block align-middle" aria-hidden>
      <rect x={x(1)} y={6} width={x(3) - x(1)} height={4} rx={2} fill="rgb(var(--bg-inset))" />
      <line x1={4} x2={W - 4} y1={8} y2={8} stroke="rgb(var(--line))" />
      {[1, 3, 10, 20].map((p) => (
        <line key={p} x1={x(p)} x2={x(p)} y1={4} y2={12} stroke="rgb(var(--line))" />
      ))}
      {pos !== null && (
        <circle cx={x(pos)} cy={8} r={5} fill={ORGANIC} stroke="rgb(var(--surface))" strokeWidth={2} />
      )}
    </svg>
  )
}

function Ledger({ report }: { report: SerpTwinReport }) {
  const [verdict, setVerdict] = React.useState('all')
  const shown = report.verdicts.filter(
    (v) => v.verdict !== 'hold' && (verdict === 'all' || v.verdict === verdict),
  )
  const max = Math.max(1, ...report.verdicts.map((v) => v.monthlyCost))
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        One row per real search, with its paid life and its organic life side by side. The strip shows organic
        position from 1 to 20; the shaded end is the top three. Google Ads and Search Console never put these
        on one line.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {['all', 'harvest', 'defend', 'bridge', 'gap'].map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={verdict === v}
            onClick={() => setVerdict(v)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium',
              verdict === v
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-line bg-surface text-ink-muted',
            )}
          >
            {v === 'all' ? 'All verdicts' : verdictShort(v)}{' '}
            <span className="tnum text-ink-faint">
              {v === 'all'
                ? report.verdicts.filter((x) => x.verdict !== 'hold').length
                : report.verdicts.filter((x) => x.verdict === v).length}
            </span>
          </button>
        ))}
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              {[
                'Search',
                'Intent',
                'Paid / mo',
                '',
                'Conv / mo',
                'Organic',
                'Rival overlap',
                'Verdict',
                'Why',
              ].map((h, i) => (
                <th
                  key={i}
                  className={cn(
                    'label whitespace-nowrap px-3 py-2.5',
                    (i === 2 || i === 4 || i === 6) && 'text-right',
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((v) => (
              <tr key={v.key} className="align-middle">
                <td className="min-w-[180px] px-3 py-2 font-medium text-ink">{v.display}</td>
                <td className="whitespace-nowrap px-3 py-2 text-ink-muted">
                  <span
                    className="mr-1.5 inline-block h-2 w-2 rounded-sm"
                    style={{ background: INTENT_COLOR[v.intent] }}
                  />
                  {INTENT_LABEL[v.intent]}
                </td>
                <td className="tnum px-3 py-2 text-right">{money(v.monthlyCost)}</td>
                <td className="w-[90px] px-3 py-2">
                  <div
                    className="h-2 rounded"
                    style={{ width: Math.max(2, (v.monthlyCost / max) * 80), background: PAID }}
                  />
                </td>
                <td className="tnum px-3 py-2 text-right">{v.monthlyConversions.toFixed(1)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <PositionStrip pos={v.position} />{' '}
                  <span className="tnum text-xs text-ink-faint">
                    {v.position === null ? 'not ranking' : `#${v.position.toFixed(1)}`}
                  </span>
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {v.competitorOverlap ? pct(v.competitorOverlap) : '—'}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={VERDICT_TONE[v.verdict]}>{verdictShort(v.verdict)}</Badge>
                </td>
                <td className="min-w-[260px] px-3 py-2 text-xs text-ink-muted">{v.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------ Claim Genome */

function GenomeView({ report }: { report: SerpTwinReport }) {
  const [intent, setIntent] = React.useState<Intent>(
    report.genome.find((g) => g.intent === 'transactional')?.intent ??
      report.genome[0]?.intent ??
      'transactional',
  )
  const g = report.genome.find((x) => x.intent === intent) ?? report.genome[0]
  if (!g) return <p className="text-[13px] text-ink-muted">Not enough ad asset data to score claims yet.</p>
  const effects = g.effects
  const lo = Math.log(0.6)
  const hi = Math.log(1.9)
  const W = 640
  const L = 150
  const R = 20
  const rowH = 30
  const top = 26
  const H = top + effects.length * rowH + 26
  const x = (v: number) => L + ((Math.log(Math.min(1.9, Math.max(0.6, v))) - lo) / (hi - lo)) * (W - L - R)
  const dot = (s: string) =>
    s === 'winner' ? 'rgb(var(--ok-fg))' : s === 'loser' ? 'rgb(var(--danger-fg))' : 'rgb(var(--ink-faint))'

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Every live RSA asset, broken into the promises it makes. Lifts come from a regression with ad-group
        fixed effects, so a headline carrying two claims does not credit both with one result, and shrinkage
        stops a 30-impression asset topping the table by luck. A claim is called a winner or loser only at 95%
        confidence.
      </p>
      <div className="inline-flex overflow-hidden rounded-lg border border-line">
        {report.genome.map((x) => (
          <button
            key={x.intent}
            type="button"
            aria-pressed={x.intent === g.intent}
            onClick={() => setIntent(x.intent)}
            className={cn(
              'px-3.5 py-1.5 text-[13px]',
              x.intent === g.intent
                ? 'bg-brand-solid text-brand-on'
                : 'bg-surface text-ink-muted hover:text-ink',
            )}
          >
            {INTENT_LABEL[x.intent]}
          </button>
        ))}
      </div>
      <Card className="p-4">
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full min-w-[600px] max-w-[780px]"
            role="img"
            aria-label="Value per impression lift by claim with 95% intervals"
          >
            <text x={L} y={12} fontSize={12} fill="rgb(var(--ink-muted))">
              Value per impression against the ad-group baseline (log scale)
            </text>
            {[0.6, 0.8, 1, 1.25, 1.5, 1.9].map((t) => (
              <g key={t}>
                <line
                  x1={x(t)}
                  x2={x(t)}
                  y1={top - 6}
                  y2={H - 22}
                  stroke={t === 1 ? 'rgb(var(--ink-faint))' : 'rgb(var(--line))'}
                  strokeDasharray={t === 1 ? '3 3' : undefined}
                />
                <text x={x(t)} y={H - 6} fontSize={11.5} textAnchor="middle" fill="rgb(var(--ink-muted))">
                  {t === 1 ? '0%' : signed(t - 1)}
                </text>
              </g>
            ))}
            {effects.map((e, i) => {
              const y = top + i * rowH + rowH / 2
              return (
                <g key={e.claim}>
                  <title>{`${CLAIM_LABEL[e.claim]}: value/impr ${signed(e.vpiLift - 1)} (95% ${signed(e.vpiCi95[0] - 1)} to ${signed(e.vpiCi95[1] - 1)}), CTR ${signed(e.ctrLift - 1)}, conv. ${signed(e.cvrLift - 1)}, P(win) ${e.pWin.toFixed(2)}`}</title>
                  <text x={8} y={y + 4} fontSize={12.5} fontWeight={500} fill="rgb(var(--ink))">
                    {CLAIM_LABEL[e.claim]}
                  </text>
                  <line
                    x1={x(e.vpiCi95[0])}
                    x2={x(e.vpiCi95[1])}
                    y1={y}
                    y2={y}
                    stroke="rgb(var(--ink-muted))"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  <circle
                    cx={x(e.vpiLift)}
                    cy={y}
                    r={6}
                    fill={dot(e.status)}
                    stroke="rgb(var(--surface))"
                    strokeWidth={2}
                  />
                </g>
              )
            })}
          </svg>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              {[
                'Claim',
                'What it means',
                'CTR',
                'Conv. rate',
                'Value / impr.',
                'P(win)',
                'Assets',
                'Call',
                'Best proven wording',
              ].map((h, i) => (
                <th
                  key={h}
                  className={cn('label whitespace-nowrap px-3 py-2.5', i >= 2 && i <= 6 && 'text-right')}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {effects.map((e) => (
              <tr key={e.claim}>
                <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">{CLAIM_LABEL[e.claim]}</td>
                <td className="min-w-[200px] px-3 py-2 text-xs text-ink-muted">
                  {CLAIM_DEFINITION[e.claim]}
                </td>
                <td className="tnum px-3 py-2 text-right">{signed(e.ctrLift - 1)}</td>
                <td className="tnum px-3 py-2 text-right">{signed(e.cvrLift - 1)}</td>
                <td className="tnum px-3 py-2 text-right font-semibold">{signed(e.vpiLift - 1)}</td>
                <td className="tnum px-3 py-2 text-right">{e.pWin.toFixed(2)}</td>
                <td className="tnum px-3 py-2 text-right">{e.assets}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <Badge tone={e.status === 'winner' ? 'ok' : e.status === 'loser' ? 'danger' : 'neutral'}>
                    {e.status === 'winner' ? 'Winner' : e.status === 'loser' ? 'Loser' : 'Unclear'}
                  </Badge>
                  {e.ctrLift >= 1.03 && e.cvrLift < 0.97 && (
                    <Badge tone="warn" className="ml-1">
                      Clickbait
                    </Badge>
                  )}
                </td>
                <td className="min-w-[180px] px-3 py-2 font-mono text-xs text-ink">
                  {e.exemplar?.text ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/* ---------------------------------------------------------- Paid → organic */

function Snippet({
  label,
  url,
  title,
  meta,
  claims,
  added,
  px,
}: {
  label: string
  url: string
  title: string
  meta: string
  claims: string[]
  added?: string
  px: number
}) {
  const over = px > SERP_LIMITS.titlePx
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <div className="label mb-2">{label}</div>
      <div className="break-all text-[13px] text-ok-fg">{url.replace('https://', '')}</div>
      <div className="mt-0.5 break-words font-[Arial,sans-serif] text-[18px] leading-snug text-info-fg">
        {title}
      </div>
      <p className="mt-1 font-[Arial,sans-serif] text-[13px] leading-relaxed text-ink-muted">{meta}</p>
      <div className="mt-3 h-2 overflow-hidden rounded bg-bg-inset">
        <div
          className={cn('h-full rounded', over ? 'bg-danger-fg' : 'bg-info-fg')}
          style={{ width: `${Math.min(100, (px / SERP_LIMITS.titlePx) * 100)}%` }}
        />
      </div>
      <div className="tnum mt-1 text-2xs text-ink-faint">
        {Math.round(px)} of {SERP_LIMITS.titlePx} px before Google truncates
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {claims.length === 0 ? (
          <Badge>No persuasive claim</Badge>
        ) : (
          claims.map((c) => (
            <Badge key={c} tone={c === added ? 'ok' : 'neutral'}>
              {CLAIM_LABEL[c as keyof typeof CLAIM_LABEL]}
            </Badge>
          ))
        )}
      </div>
    </div>
  )
}

function TransferView({
  runId,
  report,
  actions,
  canSubmit,
}: {
  runId: string
  report: SerpTwinReport
  actions: Record<string, ActionState>
  canSubmit: boolean
}) {
  const recFor = (url: string) =>
    report.recommendations.find(
      (r) => r.engine === 'transfer' && !r.id.startsWith('tr-dup-') && r.actions.some((a) => (a.payload as { url?: string }).url === url),
    )
  const portfolio = report.recommendations.filter((r) => r.id.startsWith('pf-'))
  const siteIssues = report.recommendations.filter((r) => r.id.startsWith('tr-dup-'))
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        SEO has no fast A/B test. Paid search runs thousands of copy trials a day on the same people typing
        the same words. Where a claim has proven itself in the ads for the searches a page serves, and the
        page&rsquo;s snippet does not make it, the title and description are rewritten with the words that
        already won. The title keeps the keyword that ranks today and is measured in pixels, the way Google
        truncates it.
      </p>
      {siteIssues.length > 0 && (
        <div className="space-y-2.5">
          <h3 className="text-[15px] font-semibold text-ink">Fix first: pages sharing a title</h3>
          <p className="max-w-3xl text-[13px] text-ink-muted">
            A page needs its own title before a winning ad claim can be tested on it. Pages that share a title
            are left out of the rewrites below until this is fixed.
          </p>
          {siteIssues.map((rec) => (
            <RecommendationCard key={rec.id} runId={runId} rec={rec} action={actions[rec.id]} canSubmit={canSubmit} />
          ))}
        </div>
      )}
      {report.rewrites.length === 0 && siteIssues.length === 0 && (
        <Card className="p-5 text-[13px] text-ink-muted">
          No page is missing a proven claim for its searches.
        </Card>
      )}
      {report.rewrites.map((w) => {
        const rec = recFor(w.url)
        return (
          <Card key={w.url}>
            <CardHeader
              title={new URL(w.url).pathname}
              description={`${pct(w.intentShare)} of impressions ${INTENT_LABEL[w.intent].toLowerCase()} · ${Math.round(w.monthlyOrganicClicks).toLocaleString('en-GB')} organic clicks a month`}
            />
            <div className="grid gap-3 p-4 md:grid-cols-2">
              <Snippet
                label="Now"
                url={w.url}
                title={w.current.title}
                meta={w.current.meta}
                claims={w.current.claims}
                px={w.current.titlePx}
              />
              <Snippet
                label="Proposed"
                url={w.url}
                title={w.proposed.title}
                meta={w.proposed.meta}
                claims={w.proposed.claims}
                added={w.addedClaim.claim}
                px={w.proposed.titlePx}
              />
            </div>
            <p className="px-4 pb-4 text-[13px] leading-relaxed text-ink-muted">
              Adds <strong className="text-ink">{CLAIM_LABEL[w.addedClaim.claim]}</strong>: in ads for these
              searches it moved CTR {signed(w.addedClaim.ctrLift - 1)} and conversion rate{' '}
              {signed(w.addedClaim.cvrLift - 1)}, across {w.addedClaim.assets} assets and{' '}
              {w.addedClaim.impressions.toLocaleString('en-GB')} impressions. {w.substantiate[0]}
              {w.blocked && <strong className="text-danger-fg"> Blocked: {w.blocked}</strong>}
            </p>
            {rec && (
              <div className="border-t border-line p-4">
                <RecommendationCard runId={runId} rec={rec} action={actions[rec.id]} canSubmit={canSubmit} />
              </div>
            )}
          </Card>
        )
      })}
      {portfolio.length > 0 && (
        <div className="space-y-2.5">
          <h3 className="pt-2 text-[15px] font-semibold text-ink">Shared results pages</h3>
          <p className="text-[13px] text-ink-muted">
            Where your ad and your organic listing appear on the same results page, they should not make the
            same promise twice.
          </p>
          {portfolio.map((rec) => (
            <RecommendationCard
              key={rec.id}
              runId={runId}
              rec={rec}
              action={actions[rec.id]}
              canSubmit={canSubmit}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ Intent drift */

function MixBar({ dist }: { dist: Record<Intent, number> }) {
  return (
    <div className="flex h-5 gap-0.5 overflow-hidden rounded">
      {INTENTS.filter((i) => dist[i] > 0.002).map((i) => (
        <span
          key={i}
          title={`${INTENT_LABEL[i]}: ${pct(dist[i], 1)}`}
          style={{ width: `${dist[i] * 100}%`, background: INTENT_COLOR[i] }}
        />
      ))}
    </div>
  )
}

function DriftView({ report }: { report: SerpTwinReport }) {
  const flagged = report.drifts.filter((d) => d.flagged)
  const shown = [
    ...flagged,
    ...report.drifts
      .filter((d) => !d.flagged)
      .sort((a, b) => b.divergence - a.divergence)
      .slice(0, Math.max(0, 3 - flagged.length)),
  ]
  const recs = report.recommendations.filter((x) => x.engine === 'drift')
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        A broad-match keyword is a contract with Google&rsquo;s matching, and the contract drifts. Each
        keyword&rsquo;s intent mix in the first six weeks is compared with the last fourteen days. When money
        moves to searches a buyer campaign should not pay for, negatives are mined and every one is checked
        against every search that ever converted in the account.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {INTENTS.map((i) => (
          <span key={i}>
            <span
              className="mr-1.5 inline-block h-2 w-2 rounded-sm"
              style={{ background: INTENT_COLOR[i] }}
            />
            {INTENT_LABEL[i]}
          </span>
        ))}
      </div>
      {shown.map((d) => {
        const rec = recs.find((x) => x.title.includes(`“${d.keyword}”`))
        const neg = rec?.evidence.filter((e) => e.label.startsWith('Negative')) ?? []
        const rej = rec?.evidence.filter((e) => e.label.startsWith('Rejected')) ?? []
        return (
          <Card key={d.keywordId} className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-ink">
                &ldquo;{d.keyword}&rdquo;{' '}
                <span className="font-normal text-ink-faint">{d.matchType.toLowerCase()} match</span>
              </h3>
              <span className="flex items-center gap-2">
                <Badge tone={d.flagged ? 'danger' : 'neutral'}>{d.flagged ? 'Drifting' : 'Stable'}</Badge>
                <span className="tnum font-mono text-xs text-ink-faint">
                  JS divergence {d.divergence.toFixed(3)}
                </span>
              </span>
            </div>
            <div className="grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-2 text-xs text-ink-faint">
              <span>Weeks 1–6</span>
              <MixBar dist={d.baseline} />
              <span>Last 14 days</span>
              <MixBar dist={d.recent} />
            </div>
            <p className="text-[13px] text-ink-muted">
              Spend on non-buyer searches:{' '}
              <strong className="tnum text-ink">
                {pct(d.offIntentShareBaseline)} → {pct(d.offIntentShareRecent)}
              </strong>
              {d.emergingTerms.length > 0 && (
                <>
                  {' '}
                  · new this fortnight:{' '}
                  {d.emergingTerms
                    .slice(0, 4)
                    .map((t) => `“${t.term}”`)
                    .join(', ')}
                </>
              )}
            </p>
            {d.flagged && rec && (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="label mb-1.5">Negatives, safe to add</div>
                  <ul className="space-y-1">
                    {neg.map((e) => (
                      <li
                        key={e.label}
                        className="flex justify-between gap-3 rounded-md bg-ok-bg px-2.5 py-1.5 text-xs"
                      >
                        <span className="whitespace-nowrap font-mono text-ink">
                          {e.label.replace('Negative ', '')}
                        </span>
                        <span className="text-right text-ink-muted">{e.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="label mb-1.5">Rejected: would block revenue</div>
                  <ul className="space-y-1">
                    {rej.length === 0 && <li className="text-xs text-ink-faint">None</li>}
                    {rej.map((e) => (
                      <li
                        key={e.label}
                        className="flex justify-between gap-3 rounded-md bg-danger-bg px-2.5 py-1.5 text-xs"
                      >
                        <span className="whitespace-nowrap font-mono text-ink">
                          {e.label.replace('Rejected ', '')}
                        </span>
                        <span className="text-right text-ink-muted">{e.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------- Pause test */

function PauseView({ report }: { report: SerpTwinReport }) {
  const d = report.pauseTest
  const [truth, setTruth] = React.useState(78)
  const [seed, setSeed] = React.useState(11)
  const readout = React.useMemo(() => {
    if (!d || d.schedule.length === 0) return null
    return readPauseTest(
      simulatePauseTest(d, { seed, recapture: truth / 100 }),
      Math.max(0, d.breakEvenRecapture),
    )
  }, [d, seed, truth])

  if (!d)
    return (
      <Card className="p-5 text-[13px] text-ink-muted">
        No search qualifies for a pause test in this account.
      </Card>
    )

  const facts: [string, string][] = [
    ['Searches in the test', String(d.queries.length)],
    ['Length', Number.isFinite(d.totalDays) ? `${d.totalDays} days` : 'untestable'],
    ['Break-even recapture', pct(Math.max(0, d.breakEvenRecapture))],
    ['Published prior', pct(d.recapturePrior)],
    ['Precision', `±${pct(d.expectedSe)} (1 s.e.)`],
    ['Worst-case cost', money(d.worstCaseCost)],
    ['Spend in the cell', `${money(d.monthlyCost)}/mo`],
    ['Value of running it', `${money(d.valueOfTest)}/mo`],
  ]
  const W = 560
  const sx = (v: number) => 16 + ((Math.max(-0.2, Math.min(1.2, v)) + 0.2) / 1.4) * (W - 32)

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Ranking first organically does not make the ad worthless: Google&rsquo;s own study of 446 pause events
        found half of ad clicks are still incremental at #1. The only way to know for this account is to
        measure it. The searches are picked, the test is sized, and the result that would justify a pause is
        stated before it starts.
      </p>
      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="label">{k}</dt>
              <dd className="tnum mt-0.5 font-mono text-[14px] text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-1">
          {d.queries.map((q) => (
            <Badge key={q.key}>{q.display}</Badge>
          ))}
        </div>
        {d.deferred.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-ink-muted">
            {d.deferred.map((x) => (
              <li key={x.key}>
                Held back: <span className="text-ink">{x.display}</span>, {x.reason}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="text-[14px] font-semibold text-ink">Switchback schedule</h3>
          <p className="mt-1 text-[13px] text-ink-muted">
            Ads run on filled days and are blocked with exact-match negatives on dashed days. Week two mirrors
            week one, so every weekday is seen both ways.
          </p>
          <div className="mt-3 grid max-w-[520px] grid-cols-7 gap-1">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => (
              <span key={x} className="text-center text-2xs text-ink-faint">
                {x}
              </span>
            ))}
            {d.schedule.map((a, i) => (
              <span
                key={i}
                className={cn(
                  'rounded py-1 text-center text-2xs font-semibold',
                  a === 'on'
                    ? 'text-white'
                    : 'border border-dashed border-line-strong bg-bg-inset text-ink-muted',
                )}
                style={a === 'on' ? { background: PAID } : undefined}
              >
                {a === 'on' ? 'On' : 'Off'}
              </span>
            ))}
          </div>
        </Card>
        <Card className="p-4">
          <h3 className="text-[14px] font-semibold text-ink">Try it against the simulator</h3>
          <p className="mt-1 text-[13px] text-ink-muted">
            Set the true recapture rate the engine cannot see, then read the test out the way it would be read
            on a live account. Nothing here is stored.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px] text-ink-muted">
            <label className="flex items-center gap-2" htmlFor="st-truth">
              True recapture
              <input
                id="st-truth"
                type="range"
                min={0}
                max={100}
                value={truth}
                onChange={(e) => setTruth(+e.target.value)}
                className="w-40 accent-[rgb(var(--brand-600))]"
              />
              <strong className="tnum text-ink">{truth}%</strong>
            </label>
            <label className="flex items-center gap-2" htmlFor="st-seed">
              Run
              <input
                id="st-seed"
                type="number"
                min={1}
                value={seed}
                onChange={(e) => setSeed(Math.max(1, +e.target.value || 1))}
                className="w-16 rounded-md border border-line bg-bg px-2 py-1"
              />
            </label>
          </div>
          {readout && (
            <div className="mt-3 space-y-2">
              <div
                className={cn(
                  'text-lg font-semibold',
                  readout.decision === 'pause'
                    ? 'text-ok-fg'
                    : readout.decision === 'resume'
                      ? 'text-danger-fg'
                      : 'text-warn-fg',
                )}
              >
                {readout.decision === 'pause'
                  ? 'Pause these ads'
                  : readout.decision === 'resume'
                    ? 'Keep these ads'
                    : 'Extend the test'}
              </div>
              <p className="text-[13px] text-ink">{readout.explanation}</p>
              <svg
                viewBox={`0 0 ${W} 86`}
                className="block w-full max-w-[600px]"
                role="img"
                aria-label="Measured recapture with 95% interval against break-even"
              >
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <g key={t}>
                    <line x1={sx(t)} x2={sx(t)} y1={20} y2={60} stroke="rgb(var(--line))" />
                    <text x={sx(t)} y={78} textAnchor="middle" fontSize={11} fill="rgb(var(--ink-muted))">
                      {t * 100}%
                    </text>
                  </g>
                ))}
                <line
                  x1={sx(readout.breakEvenRecapture)}
                  x2={sx(readout.breakEvenRecapture)}
                  y1={12}
                  y2={64}
                  stroke="rgb(var(--ink-faint))"
                  strokeDasharray="3 3"
                />
                <text
                  x={sx(readout.breakEvenRecapture) + 4}
                  y={12}
                  fontSize={11}
                  fill="rgb(var(--ink-muted))"
                >
                  break-even {pct(readout.breakEvenRecapture)}
                </text>
                <line
                  x1={sx(truth / 100)}
                  x2={sx(truth / 100)}
                  y1={28}
                  y2={52}
                  stroke="rgb(var(--warn-fg))"
                  strokeWidth={2}
                />
                <line
                  x1={sx(readout.ci95[0])}
                  x2={sx(readout.ci95[1])}
                  y1={40}
                  y2={40}
                  stroke="rgb(var(--ink-muted))"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                <circle
                  cx={sx(readout.recapture)}
                  cy={40}
                  r={6}
                  fill={ORGANIC}
                  stroke="rgb(var(--surface))"
                  strokeWidth={2}
                />
              </svg>
              <p className="text-2xs text-ink-faint">
                Blue: measured, with 95% interval. Amber line: the truth you set, hidden from the engine.
                Simulated readout.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
