import type { Confidence, Engine, Intent, Recommendation, SerpTwinInput, SerpTwinSettings } from './types'
import { DEFAULT_SETTINGS } from './types'
import { buildLedger, monthly, type Ledger } from './ledger'
import { fitCtrCurve, type CtrCurve } from './ctr'
import { judgeQueries, overlapRecommendations, type QueryVerdict } from './engines/overlap'
import { designPauseTest, pauseTestRecommendation, type PauseTestDesign } from './engines/experiment'
import { buildGenome, genomeRecommendations, type ClaimEffect, type Genome } from './engines/genome'
import { proposeRewrites, transferRecommendations, type PageRewrite } from './engines/transfer'
import { driftRecommendations, measureDrift, type KeywordDrift } from './engines/drift'
import {
  diagnoseLeads,
  leadRecommendations,
  type LeadCategory,
  type LeadUnit,
  type OfflineConversionRow,
} from './engines/leads'
import { capacityRecommendation, planBudgets, type ServicePlan } from './engines/capacity'
import { demandRecommendations, prioritiseSeo, type DemandAction } from './engines/demand'

export * from './types'
export { CLAIM_LABEL, CLAIM_DEFINITION, extractClaims } from './claims'
export { classifyIntent } from './intent'
export { VERDICT_LABEL } from './engines/overlap'
export { readPauseTest, switchbackSchedule } from './engines/experiment'
export { LEAD_CATEGORY_LABEL, NOT_A_PROSPECT, type LeadCategory } from './engines/leads'
export { TOPIC_LABEL, type Topic } from './engines/demand'

/**
 * SERP Twin — one run over a workspace's paid and organic search data.
 *
 * Pure: no I/O, no model call, no clock. Same input, same report, byte for
 * byte, which is what lets the report be hashed into the audit chain and
 * lets an approved recommendation be checked against the evidence it was
 * approved on.
 */

export interface SerpTwinReport {
  workspace: string
  simulated: boolean
  /** What in a simulated run is real and what is made up, when the account says. */
  dataNote?: string
  window: Ledger['window']
  settings: SerpTwinSettings
  curve: CtrCurve
  summary: {
    queries: number
    monthlyPaidSpend: number
    /** Paid spend on searches where the site already ranks top three organically. */
    monthlyOverlapSpend: number
    monthlyOffIntentSpend: number
    pagesAnalysed: number
    assetsScored: number
  }
  verdicts: QueryVerdict[]
  pauseTest: PauseTestDesign | null
  genome: { intent: Intent; effects: ClaimEffect[] }[]
  rewrites: PageRewrite[]
  drifts: KeywordDrift[]
  recommendations: Recommendation[]
  impactByEngine: Record<Engine, number>
  /** Present when the workspace has a business profile and enquiries. */
  leads: LeadReport | null
  budgets: ServicePlan[] | null
  seo: DemandAction[] | null
}

export interface LeadReport {
  total: number
  counts: Record<LeadCategory, number>
  units: LeadUnit[]
  paidEnquiries: number
  paidNotProspects: number
  winRateAnswered: number | null
  winRateMissed: number | null
  /** Per enquiry: the category and the evidence for it. Joined to the enquiry rows by id. */
  classified: { id: string; category: LeadCategory; evidence: string[]; serviceId: string | null }[]
  offlineRows: OfflineConversionRow[]
}

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { measured: 1, estimated: 0.7, hypothesis: 0.4 }

export function rankRecommendations(recs: Recommendation[]): Recommendation[] {
  return [...recs].sort((a, b) => {
    const sa = a.monthlyImpact * CONFIDENCE_WEIGHT[a.confidence]
    const sb = b.monthlyImpact * CONFIDENCE_WEIGHT[b.confidence]
    return sb - sa || a.id.localeCompare(b.id)
  })
}

export function runSerpTwin(input: SerpTwinInput, overrides: Partial<SerpTwinSettings> = {}): SerpTwinReport {
  const settings = { ...DEFAULT_SETTINGS, ...overrides }
  const ledger = buildLedger(input, settings)
  const curve = fitCtrCurve(input.organic)

  const verdicts = judgeQueries(ledger, curve, settings)
  const pauseTest = designPauseTest(
    input,
    verdicts.filter((v) => v.verdict === 'harvest'),
    settings,
  )
  const genome: Genome = buildGenome(input, ledger)
  const drifts = measureDrift(input, ledger, settings)

  const recs: Recommendation[] = [
    ...(pauseTest ? [pauseTestRecommendation(pauseTest, settings)] : []),
    ...overlapRecommendations(verdicts, settings, input.business?.notOffered ?? []),
    ...genomeRecommendations(input, genome, ledger, settings),
    ...transferRecommendations(input, ledger, genome, settings),
    ...driftRecommendations(input, ledger, drifts, settings),
  ]

  // Engines 5–7 need to know the business: what it sells, for what profit, with what capacity.
  const leadDiagnosis = diagnoseLeads(input, ledger.window.days)
  const budgets = leadDiagnosis ? planBudgets(input, leadDiagnosis, ledger.window.days) : null
  const seo = leadDiagnosis ? prioritiseSeo(input, leadDiagnosis, ledger.window.days) : null
  if (leadDiagnosis) {
    recs.push(...leadRecommendations(input, leadDiagnosis, settings))
    const cap = capacityRecommendation(input, budgets!, settings)
    if (cap) recs.push(cap)
    recs.push(...demandRecommendations(seo!, settings))
  }

  corroborate(recs)

  const impactByEngine: Record<Engine, number> = {
    overlap: 0,
    genome: 0,
    transfer: 0,
    drift: 0,
    leads: 0,
    capacity: 0,
    demand: 0,
  }
  for (const r of recs) impactByEngine[r.engine] += r.monthlyImpact

  const days = ledger.window.days
  const paid = ledger.entries.reduce((s, e) => s + e.paid.cost, 0)
  const overlap = ledger.entries
    .filter((e) => e.organic.position !== null && e.organic.position <= 3)
    .reduce((s, e) => s + e.paid.cost, 0)
  const offIntent = ledger.entries
    .filter((e) => ['careers', 'free_seeker', 'informational'].includes(e.intent))
    .reduce((s, e) => s + e.paid.cost, 0)

  return {
    workspace: input.workspace,
    simulated: input.simulated,
    ...(input.dataNote ? { dataNote: input.dataNote } : {}),
    window: ledger.window,
    settings,
    curve,
    summary: {
      queries: ledger.entries.length,
      monthlyPaidSpend: monthly(paid, days),
      monthlyOverlapSpend: monthly(overlap, days),
      monthlyOffIntentSpend: monthly(offIntent, days),
      pagesAnalysed: input.pages.length,
      assetsScored: genome.assets.length,
    },
    verdicts,
    pauseTest,
    genome: [...genome.byIntent.entries()].map(([intent, effects]) => ({ intent, effects })),
    rewrites: proposeRewrites(input, ledger, genome),
    drifts,
    recommendations: rankRecommendations(recs),
    impactByEngine,
    leads: leadDiagnosis
      ? {
          total: leadDiagnosis.total,
          counts: leadDiagnosis.counts,
          units: leadDiagnosis.units,
          paidEnquiries: leadDiagnosis.paidEnquiries,
          paidNotProspects: leadDiagnosis.paidNotProspects,
          winRateAnswered: leadDiagnosis.winRateAnswered,
          winRateMissed: leadDiagnosis.winRateMissed,
          classified: leadDiagnosis.classified.map((c) => ({
            id: c.lead.id,
            category: c.category,
            evidence: c.evidence,
            serviceId: c.serviceId,
          })),
          offlineRows: leadDiagnosis.offlineRows,
        }
      : null,
    budgets,
    seo,
  }
}

/**
 * When the portfolio engine and the genome independently reach the same
 * headline for the same ad group, keep one recommendation and say that two
 * engines agree — one change on the approval queue, stronger evidence.
 */
function corroborate(recs: Recommendation[]): void {
  for (const pin of recs.filter((r) => r.actions.some((a) => a.kind === 'pin_headline'))) {
    const p = pin.actions.find((a) => a.kind === 'pin_headline')!.payload as {
      adGroupId: string
      text: string
    }
    const i = recs.findIndex(
      (r) =>
        r.engine === 'genome' &&
        r.actions.some(
          (a) =>
            (a.kind === 'add_headline' || a.kind === 'replace_headline') &&
            (a.payload as { adGroupId: string; addText: string }).adGroupId === p.adGroupId &&
            (a.payload as { addText: string }).addText === p.text,
        ),
    )
    if (i < 0) continue
    const g = recs[i]!
    pin.summary += ' The Claim Genome flagged the same headline for this ad group independently.'
    pin.evidence.push({ label: 'Corroborated by', value: g.title })
    pin.monthlyImpact = Math.max(pin.monthlyImpact, g.monthlyImpact)
    recs.splice(i, 1)
  }
}
