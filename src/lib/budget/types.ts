/**
 * Budget Allocator — shared types.
 *
 * Pure module: no I/O and no `server-only`, so client components can import the
 * shapes they render.
 *
 * Money is held in integer minor units (pence) everywhere in this module.
 * Budgets are summed, split and compared thousands of times in an allocation,
 * and floating-point pounds drift by a penny per few hundred operations — which
 * is exactly the kind of discrepancy the reconciliation half of the module is
 * there to catch. Converting once at the edge keeps the module honest with
 * itself.
 *
 * Three rules run through the whole module:
 *
 *  1. Every number says where it came from: a platform, a card, a statement, a
 *     person, or the simulator. Simulated numbers are never shown as real.
 *  2. A recommendation carries its uncertainty. An allocator that prints one
 *     confident figure from twelve noisy weeks is guessing in a suit.
 *  3. Plan, platform and card are reconciled — the three-way match. A budget
 *     that only knows what the ad platforms *say* they spent cannot see a
 *     duplicate charge, an FX fee, or a card used for something nobody budgeted.
 */

/* ------------------------------------------------------------ categories */

export type LineCategory =
  | 'paid_media' // auction media: response curves apply
  | 'owned' // email, SEO content, organic social: curves apply when outcomes are tracked
  | 'production' // creative, video, photography
  | 'tools' // SaaS and data subscriptions
  | 'ai' // model and generation costs (Aurea's own usage lands here)
  | 'people' // agency fees, freelancers
  | 'events' // events, sponsorship, field marketing
  | 'offline' // print, out-of-home, radio
  | 'reserve' // contingency held back on purpose

export type Objective = 'conversions' | 'revenue' | 'profit'

export type Provenance = 'aurea' | 'platform' | 'card' | 'statement' | 'manual' | 'simulated'

/* --------------------------------------------------------------- history */

/** One week of one channel: what went in and what came out. */
export type Observation = {
  /** ISO date of the Monday that starts the week. */
  weekStart: string
  spendPence: number
  conversions: number
  revenuePence: number
  source: Provenance
}

/* ---------------------------------------------------------------- curves */

/**
 * Geometric adstock plus Hill saturation — the same family Google Meridian and
 * Meta Robyn use, fitted here per channel without a full MMM.
 *
 *   adstock_t  = spend_t + theta · adstock_{t-1}
 *   response_t = beta · adstock_t^alpha / (adstock_t^alpha + gamma^alpha)
 *
 * gamma is the adstocked weekly spend at which the channel delivers half its
 * ceiling (beta). alpha shapes the curve: below 1 it is concave from the first
 * pound; above 1 it is S-shaped, with a threshold before spend starts working.
 */
export type CurveParams = {
  beta: number
  alpha: number
  /** Half-saturation point, pence of adstocked weekly spend. */
  gamma: number
  /** Carryover per week, 0–0.9. */
  theta: number
}

/**
 * A curve is a weighted mixture. With plenty of history it is one fitted
 * component; with little, the fit is blended with a weak prior in proportion to
 * how much evidence there is (credibility weighting), so twelve weeks of data
 * cannot produce a curve that promises the moon at three times current spend.
 */
export type Curve = {
  components: { params: CurveParams; weight: number }[]
}

export type CurveFit = {
  channelKey: string
  metric: 'conversions' | 'revenue'
  /** Point estimate. */
  curve: Curve
  /** Bootstrap draws: the honest version of the same curve. */
  draws: Curve[]
  weeks: number
  /** Share of week-to-week variation the fitted curve explains, 0–1. */
  r2: number
  /** Weight on the fitted component; the rest is prior. */
  credibility: number
  /** Largest weekly spend ever observed. Beyond ~1.5× this, the curve is a guess. */
  maxObservedWeeklyPence: number
  meanWeeklyPence: number
  /** Spend at which the channel reaches 80% of its ceiling. */
  saturationWeeklyPence: number
  quality: 'good' | 'usable' | 'thin' | 'none'
  notes: string[]
}

/* ------------------------------------------------------------ allocation */

export type AllocationLineInput = {
  id: string
  key: string
  label: string
  category: LineCategory
  /** Pence for the whole plan period. */
  currentPence: number
  minPence: number
  /** Null for no ceiling. */
  maxPence: number | null
  locked: boolean
  /** Null when the line has no response curve; it then keeps its amount. */
  fit: CurveFit | null
  /**
   * Cash cost of one pound of platform-reported spend, from reconciliation:
   * FX fees, non-recoverable VAT, card fees. 1.03 means every £1 the platform
   * reports cost £1.03 on the card. Allocating on platform spend alone
   * silently favours the channels with the worst billing.
   */
  cashFactor: number
  /**
   * Share of platform-reported outcomes that are actually incremental, from a
   * lift test, a holdout, or deduplication against the CRM. Platforms each
   * claim the same customer; summing their claims double-counts.
   */
  incrementality: number
  /** Allow spending beyond the evidence (more than extrapolationCap × max observed week). */
  allowExtrapolation: boolean
}

export type AllocationInput = {
  totalPence: number
  weeks: number
  objective: Objective
  /** 0 = maximise expected outcome; 1 = strongly prefer outcomes we are sure of. */
  riskAversion: number
  /** 0–0.25: share of flexible budget spent where uncertainty is highest, to learn. */
  learningShare: number
  /** Default 1.5: how far past the largest observed week a curve may be trusted. */
  extrapolationCap: number
  /**
   * Largest move per line in one reallocation, as a share of its current
   * amount (Meridian's default box is ±30%). Big swings reset platform
   * learning phases and outrun the evidence. Null for no limit.
   */
  maxShift: number | null
  /** Revenue per conversion, pence, for the profit objective when only conversions are tracked. */
  valuePerConversionPence: number | null
  lines: AllocationLineInput[]
  seed?: string
}

export type Band = { mean: number; p10: number; p90: number }

export type AllocationLineResult = {
  id: string
  key: string
  label: string
  category: LineCategory
  currentPence: number
  recommendedPence: number
  deltaPence: number
  /** Part of recommendedPence that is the learning budget. */
  learningPence: number
  optimisable: boolean
  /** Expected incremental outcome over the period, at current and recommended spend. */
  outcomeCurrent: Band | null
  outcomeRecommended: Band | null
  /** Incremental outcome from the next £100 at the recommended level. */
  marginalPer100: Band | null
  /** 0–1, how far up its curve the channel sits at the recommended level. */
  saturation: number | null
  extrapolated: boolean
  /** What held this line where it is. */
  binding: 'min' | 'max' | 'locked' | 'evidence_cap' | 'shift_limit' | 'fixed' | 'none'
  reason: string
}

export type AllocationResult = {
  objective: Objective
  metric: 'conversions' | 'revenue'
  totalPence: number
  allocatedPence: number
  /** Money the allocator declined to spend because no line returns it. */
  unallocatedPence: number
  learningPence: number
  lines: AllocationLineResult[]
  totals: {
    current: Band
    recommended: Band
    /** Share of bootstrap worlds in which the recommendation beats the current split. */
    probabilityBetter: number
    upliftMean: number
  }
  warnings: string[]
  /** One paragraph a finance director could read. */
  summary: string
}

/* ---------------------------------------------------------------- pacing */

export type PacingStatus = 'on_track' | 'under' | 'over' | 'at_risk' | 'no_data'

export type PacingLine = {
  lineId: string
  label: string
  plannedPence: number
  actualPence: number
  expectedToDatePence: number
  projectedPence: number
  /** The most the platform could legitimately charge by period end at current settings. */
  worstCasePence: number | null
  variancePct: number
  status: PacingStatus
  /** Daily amount that lands the line exactly on plan from here. */
  suggestedDailyPence: number | null
  note: string
}

/* ---------------------------------------------------------- cards & money */

export type CardProvider = 'simulated' | 'csv' | 'truelayer' | 'airwallex'

export type TxStatus = 'pending' | 'settled'

/** A card transaction, normalised. Amount positive = money out; negative = refund. */
export type CardTx = {
  id: string
  cardId: string
  externalId: string
  postedAt: string // ISO date-time
  amountPence: number
  currency: string
  /** When the merchant charged in another currency. */
  originalAmountMinor: number | null
  originalCurrency: string | null
  descriptor: string
  status: TxStatus
  /** Set by classification: a platform key, a line key, or null. */
  platform: string | null
  lineId: string | null
}

/** Platform-reported spend for one platform on one day. */
export type PlatformDay = {
  platform: string
  day: string // ISO date
  spendPence: number
  source: Provenance
}

export type BillingProfile = {
  platform: string
  /** Threshold billing: a charge lands each time unbilled spend reaches this. */
  thresholdPence: number | null
  /** Charged in this currency; anything else means FX on the card. */
  billingCurrency: string
  /** UK VAT added on top of platform spend (reverse charge = 0). */
  vatRate: number
  /** Typical days between spend being incurred and the charge settling. */
  settlementLagDays: number
}

export type DiscrepancyKind =
  | 'duplicate_charge'
  | 'overcharge' // card charged more than the platform reports spending
  | 'unbilled_spend' // platform reports spend that no charge covers, beyond the billing threshold
  | 'unbudgeted_spend' // a charge on the card that no budget line owns
  | 'unknown_merchant' // a charge nobody can identify
  | 'fx_cost' // currency conversion cost above tolerance
  | 'refund_unmatched' // money back with nothing to match it to
  | 'stale_pending' // an authorisation that never settled
  | 'line_overrun' // charges for a line exceed its plan
  | 'unverifiable' // charged, but the platform is not connected so nothing confirms it

export type Severity = 'high' | 'medium' | 'low'

export type Discrepancy = {
  /** Stable across runs for the same underlying problem, so a resolution sticks. */
  fingerprint: string
  kind: DiscrepancyKind
  severity: Severity
  platform: string | null
  lineId: string | null
  amountPence: number
  txIds: string[]
  title: string
  detail: string
  suggestion: string
}

/** The three-way match for one budget line. */
export type ThreeWayRow = {
  lineId: string | null
  label: string
  platform: string | null
  plannedPence: number
  platformPence: number | null
  cardPence: number
  /** card − platform: what billing added or lost. */
  billingGapPence: number | null
  /** card − plan. */
  planGapPence: number
  matched: boolean
}

export type ReconciliationReport = {
  periodStart: string
  periodEnd: string
  rows: ThreeWayRow[]
  discrepancies: Discrepancy[]
  totals: { plannedPence: number; platformPence: number; cardPence: number; explainedPence: number }
  /** Observed cash cost of £1 of platform spend, per platform. Feeds the allocator. */
  cashFactors: Record<string, number>
  simulated: boolean
}

/** What is stored about a curve with an allocation run: enough to draw and explain it. */
export type StoredCurve = {
  channelKey: string
  metric: 'conversions' | 'revenue'
  quality: CurveFit['quality']
  r2: number
  credibility: number
  weeks: number
  maxObservedWeeklyPence: number
  meanWeeklyPence: number
  saturationWeeklyPence: number
  notes: string[]
  series: { spendPence: number; mean: number; p10: number; p90: number }[]
}

/** The settings an allocation ran with, stored beside its result. */
export type AllocationSettings = {
  objective: Objective
  riskAversion: number
  learningShare: number
  extrapolationCap: number
  maxShift: number | null
  valuePerConversionPence: number | null
  weeks: number
  totalPence: number
  cashFactors: Record<string, number>
  incrementality: Record<string, number>
  seed: string
}
