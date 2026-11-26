import type { AdAssetRow, Intent, Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import type { Ledger } from '../ledger'
import { monthly } from '../ledger'
import { ALL_CLAIMS, CLAIM_LABEL, extractClaims, type Claim } from '../claims'
import { normCdf, shrink, solve } from '../stats'
import { contentTokens, formatMoney, pct, queryKey, stableId } from '../normalise'
import { SERP_LIMITS } from '../pixel'

/**
 * ENGINE 2 — Claim Genome.
 *
 * Google reports each RSA asset's impressions, clicks and conversions, and
 * rates it "Best / Good / Low". That rating is per string, per ad group, and
 * silent on *why*. The genome asks a different question: which promises
 * work, for which buying intent, across the whole account?
 *
 *  1. Every asset is scored against its own ad group and field (headline vs
 *     description), with beta-binomial shrinkage so an asset with 40
 *     impressions cannot top the table by luck.
 *  2. Asset lifts are regressed on claim indicators with ad-group fixed
 *     effects (within transformation) and a light ridge penalty. Headlines
 *     that say "£49/month — cancel anytime" carry two claims; the regression
 *     separates what the price did from what the risk reversal did, which a
 *     per-claim average cannot.
 *  3. Three outcomes are modelled separately — CTR, conversion rate, and
 *     value per impression — because a claim that wins clicks and loses
 *     conversions is clickbait, and the transfer engine must not carry it.
 */

export interface AssetScore {
  asset: AdAssetRow
  intent: Intent
  claims: Claim[]
  ctrLift: number
  cvrLift: number
  /** log(value-per-impression lift) and its variance. */
  logVpi: number
  varVpi: number
}

export interface ClaimEffect {
  claim: Claim
  intent: Intent
  ctrLift: number
  cvrLift: number
  vpiLift: number
  vpiCi95: [number, number]
  /** P(value-per-impression lift > 1). */
  pWin: number
  assets: number
  impressions: number
  /** The best-performing real asset carrying this claim — proven words to reuse. */
  exemplar: { text: string; field: AdAssetRow['field']; adGroupId: string } | null
  status: 'winner' | 'loser' | 'unclear'
}

export interface Genome {
  assets: AssetScore[]
  byIntent: Map<Intent, ClaimEffect[]>
  adGroupIntent: Map<string, Intent>
}

const CTR_STRENGTH = 2000 // pseudo-impressions
const CVR_STRENGTH = 80 // pseudo-clicks
const MIN_ASSETS_PER_CLAIM = 3
export const WIN = { p: 0.95, lift: 1.05 }
export const LOSE = { p: 0.05, lift: 0.95 }

export function adGroupIntents(input: SerpTwinInput, ledger: Ledger): Map<string, Intent> {
  const votes = new Map<string, Map<Intent, number>>()
  for (const r of input.searchTerms) {
    const e = ledger.byKey.get(queryKey(r.searchTerm))
    if (!e) continue
    const m = votes.get(r.adGroupId) ?? new Map<Intent, number>()
    m.set(e.intent, (m.get(e.intent) ?? 0) + r.impressions)
    votes.set(r.adGroupId, m)
  }
  const out = new Map<string, Intent>()
  for (const [ag, m] of votes) out.set(ag, [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0])
  return out
}

export function scoreAssets(input: SerpTwinInput, adGroupIntent: Map<string, Intent>): AssetScore[] {
  const groups = new Map<string, AdAssetRow[]>()
  for (const a of input.assets) {
    const k = `${a.adGroupId}|${a.field}`
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  const out: AssetScore[] = []
  for (const rows of groups.values()) {
    const imp = rows.reduce((s, r) => s + r.impressions, 0)
    const clk = rows.reduce((s, r) => s + r.clicks, 0)
    const cnv = rows.reduce((s, r) => s + r.conversions, 0)
    if (imp === 0 || clk === 0) continue
    const baseCtr = clk / imp
    const baseCvr = Math.max(cnv / clk, 1e-4)
    for (const a of rows) {
      const ctr = shrink(a.clicks, a.impressions, baseCtr, CTR_STRENGTH)
      const cvr = shrink(Math.min(a.conversions, a.clicks), a.clicks, baseCvr, CVR_STRENGTH)
      const ctrLift = ctr.mean / baseCtr
      const cvrLift = cvr.mean / baseCvr
      out.push({
        asset: a,
        intent: adGroupIntent.get(a.adGroupId) ?? 'commercial',
        claims: extractClaims(a.text),
        ctrLift,
        cvrLift,
        logVpi: Math.log(ctrLift) + Math.log(cvrLift),
        varVpi: ctr.variance / ctr.mean ** 2 + cvr.variance / cvr.mean ** 2,
      })
    }
  }
  return out
}

type Outcome = 'ctr' | 'cvr' | 'vpi'

/** Weighted ridge regression of asset log-lift on claim indicators, ad-group fixed effects removed. */
function regress(scores: AssetScore[], claims: Claim[], outcome: Outcome) {
  const y0 = scores.map((s) =>
    outcome === 'ctr' ? Math.log(s.ctrLift) : outcome === 'cvr' ? Math.log(s.cvrLift) : s.logVpi,
  )
  const w = scores.map((s) => 1 / Math.max(s.varVpi, 1e-6))
  const X0 = scores.map((s) => claims.map((c) => (s.claims.includes(c) ? 1 : 0)))

  // Within transformation by (ad group, field).
  const groupOf = scores.map((s) => `${s.asset.adGroupId}|${s.asset.field}`)
  const gm = new Map<string, { w: number; y: number; x: number[] }>()
  scores.forEach((_, i) => {
    const g = gm.get(groupOf[i]!) ?? { w: 0, y: 0, x: claims.map(() => 0) }
    g.w += w[i]!
    g.y += w[i]! * y0[i]!
    X0[i]!.forEach((v, j) => (g.x[j]! += w[i]! * v))
    gm.set(groupOf[i]!, g)
  })
  const y = y0.map((v, i) => v - gm.get(groupOf[i]!)!.y / gm.get(groupOf[i]!)!.w)
  const X = X0.map((row, i) => row.map((v, j) => v - gm.get(groupOf[i]!)!.x[j]! / gm.get(groupOf[i]!)!.w))

  const k = claims.length
  const XtWX = Array.from({ length: k }, () => Array(k).fill(0) as number[])
  const XtWy = Array(k).fill(0) as number[]
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      XtWy[a]! += w[i]! * X[i]![a]! * y[i]!
      for (let b = 0; b < k; b++) XtWX[a]![b]! += w[i]! * X[i]![a]! * X[i]![b]!
    }
  }
  const trace = XtWX.reduce((s, row, i) => s + row[i]!, 0)
  const lambda = 0.02 * (trace / Math.max(1, k)) + 1e-6
  for (let a = 0; a < k; a++) XtWX[a]![a]! += lambda

  // Residual variance scales the (model-based) covariance — asset noise is rarely exactly binomial.
  const { x: beta, inv } = solve(XtWX, XtWy)
  let rss = 0
  let wsum = 0
  for (let i = 0; i < X.length; i++) {
    const fit = X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0)
    rss += w[i]! * (y[i]! - fit) ** 2
    wsum += 1
  }
  const sigma2 = Math.max(1, rss / Math.max(1, wsum - k - gm.size))
  return claims.map((c, j) => ({ claim: c, beta: beta[j]!, se: Math.sqrt(inv[j]![j]! * sigma2) }))
}

export function buildGenome(input: SerpTwinInput, ledger: Ledger): Genome {
  const adGroupIntent = adGroupIntents(input, ledger)
  const assets = scoreAssets(input, adGroupIntent)
  const byIntent = new Map<Intent, ClaimEffect[]>()

  const intents = [...new Set(assets.map((a) => a.intent))]
  for (const intent of intents) {
    const scores = assets.filter((a) => a.intent === intent)
    // Every claim that varies is a regressor, so a rare claim's effect cannot leak into a
    // common one it co-occurs with; only claims with enough carriers are reported.
    const regressors = ALL_CLAIMS.filter(
      (c) => scores.some((s) => s.claims.includes(c)) && scores.some((s) => !s.claims.includes(c)),
    )
    const reported = regressors.filter(
      (c) => scores.filter((s) => s.claims.includes(c)).length >= MIN_ASSETS_PER_CLAIM,
    )
    if (reported.length === 0 || scores.length < regressors.length + 2) continue

    const ctr = regress(scores, regressors, 'ctr')
    const cvr = regress(scores, regressors, 'cvr')
    const vpi = regress(scores, regressors, 'vpi')
    const at = (claim: Claim) => regressors.indexOf(claim)

    const effects: ClaimEffect[] = reported.map((claim) => {
      const j = at(claim)
      const carriers = scores.filter((s) => s.claims.includes(claim))
      const best = [...carriers].sort((a, b) => b.logVpi - a.logVpi)[0]
      const v = vpi[j]!
      const pWin = normCdf(v.beta / v.se)
      const lift = Math.exp(v.beta)
      return {
        claim,
        intent,
        ctrLift: Math.exp(ctr[j]!.beta),
        cvrLift: Math.exp(cvr[j]!.beta),
        vpiLift: lift,
        vpiCi95: [Math.exp(v.beta - 1.96 * v.se), Math.exp(v.beta + 1.96 * v.se)],
        pWin,
        assets: carriers.length,
        impressions: carriers.reduce((s, c) => s + c.asset.impressions, 0),
        exemplar: best
          ? { text: best.asset.text, field: best.asset.field, adGroupId: best.asset.adGroupId }
          : null,
        status:
          pWin >= WIN.p && lift >= WIN.lift
            ? 'winner'
            : pWin <= LOSE.p && lift <= LOSE.lift
              ? 'loser'
              : 'unclear',
      }
    })
    byIntent.set(
      intent,
      effects.sort((a, b) => b.vpiLift - a.vpiLift),
    )
  }
  return { assets, byIntent, adGroupIntent }
}

// ───────────────────────────── Recommendations

export function genomeRecommendations(
  input: SerpTwinInput,
  genome: Genome,
  ledger: Ledger,
  settings: SerpTwinSettings,
): Recommendation[] {
  const money = (n: number) => formatMoney(n, settings.currency)
  const recs: Recommendation[] = []
  const agName = new Map(input.adGroups.map((g) => [g.adGroupId, g.name]))

  // Monthly value per ad group, for sizing.
  const agValue = new Map<string, number>()
  for (const r of input.searchTerms) {
    const v = r.conversionValue > 0 ? r.conversionValue : r.conversions * settings.fallbackValuePerConversion
    agValue.set(r.adGroupId, (agValue.get(r.adGroupId) ?? 0) + v)
  }

  for (const ag of input.adGroups) {
    const intent = genome.adGroupIntent.get(ag.adGroupId)
    if (!intent) continue
    const effects = genome.byIntent.get(intent) ?? []
    const mine = genome.assets.filter(
      (a) => a.asset.adGroupId === ag.adGroupId && a.asset.field === 'HEADLINE',
    )
    if (mine.length === 0) continue
    const present = new Set(mine.flatMap((a) => a.claims))
    const winners = effects.filter(
      (e) =>
        e.status === 'winner' &&
        !present.has(e.claim) &&
        e.exemplar &&
        e.exemplar.text.length <= SERP_LIMITS.adHeadlineChars,
    )
    const losers = effects.filter((e) => e.status === 'loser')
    // The keyword headline earns relevance, which no claim score measures; never propose replacing it.
    const kwTokens = input.keywords
      .filter((k) => k.adGroupId === ag.adGroupId)
      .map((k) => new Set(contentTokens(k.text)))
    const isKeywordHeadline = (text: string) => {
      const t = contentTokens(text)
      return kwTokens.some((k) => t.filter((x) => k.has(x)).length >= Math.min(2, k.size))
    }
    const loserAssets = mine
      .filter((a) => !isKeywordHeadline(a.asset.text))
      .filter((a) => a.claims.some((c) => losers.some((l) => l.claim === c)))
      .sort((a, b) => b.asset.impressions - a.asset.impressions)

    const top = winners[0]
    if (!top && loserAssets.length === 0) continue

    const agImpr = mine.reduce((s, a) => s + a.asset.impressions, 0)
    const value = monthly(agValue.get(ag.adGroupId) ?? 0, ledger.window.days)
    // A new headline is one of ~15 rotating; assume it earns a quarter of serves. Conservative on purpose.
    const serveShare = 0.25
    const gain = top ? value * (top.vpiLift - 1) * serveShare : 0
    const replaced = loserAssets[0]
    const loserEffect = replaced ? losers.find((l) => replaced.claims.includes(l.claim))! : null
    const saved =
      replaced && loserEffect
        ? value * (1 - loserEffect.vpiLift) * (replaced.asset.impressions / Math.max(1, agImpr))
        : 0

    const actions: Recommendation['actions'] = []
    if (top && replaced) {
      actions.push({
        kind: 'replace_headline',
        description: `Replace “${replaced.asset.text}” with “${top.exemplar!.text}”`,
        payload: {
          adGroupId: ag.adGroupId,
          adId: replaced.asset.adId,
          removeAssetId: replaced.asset.assetId,
          addText: top.exemplar!.text,
        },
        undo: {
          kind: 'replace_headline',
          adGroupId: ag.adGroupId,
          adId: replaced.asset.adId,
          restoreText: replaced.asset.text,
        },
        requiresApproval: true,
      })
    } else if (top) {
      actions.push({
        kind: 'add_headline',
        description: `Add “${top.exemplar!.text}” — the best-performing ${CLAIM_LABEL[top.claim].toLowerCase()} headline in the account`,
        payload: { adGroupId: ag.adGroupId, addText: top.exemplar!.text },
        undo: { kind: 'remove_headline', adGroupId: ag.adGroupId, text: top.exemplar!.text },
        requiresApproval: true,
      })
    }

    const lines: string[] = []
    if (top)
      lines.push(
        `${CLAIM_LABEL[top.claim]} lifts value per impression ${pct(top.vpiLift - 1)} for ${intent} searches across the account (P = ${top.pWin.toFixed(2)}), and no headline here makes that promise.`,
      )
    if (replaced && loserEffect)
      lines.push(
        `“${replaced.asset.text}” carries ${CLAIM_LABEL[loserEffect.claim].toLowerCase()}, which costs ${pct(1 - loserEffect.vpiLift)} per impression, and takes ${pct(replaced.asset.impressions / Math.max(1, agImpr))} of this ad group's serves.`,
      )

    recs.push({
      id: `gn-${stableId(ag.adGroupId, top?.claim ?? '', replaced?.asset.assetId ?? '')}`,
      engine: 'genome',
      title: top
        ? `${agName.get(ag.adGroupId) ?? ag.adGroupId}: missing the “${CLAIM_LABEL[top.claim]}” claim that wins for ${intent} searches`
        : `${agName.get(ag.adGroupId) ?? ag.adGroupId}: “${replaced!.asset.text}” makes a promise that loses for ${intent} searches`,
      summary: lines.join(' '),
      monthlyImpact: gain + saved,
      confidence: 'estimated',
      evidence: [
        ...(top
          ? [
              {
                label: `${CLAIM_LABEL[top.claim]} — value/impr lift`,
                value: `${pct(top.vpiLift - 1)} (95% ${pct(top.vpiCi95[0] - 1)} to ${pct(top.vpiCi95[1] - 1)})`,
              },
              { label: 'CTR / CVR lift', value: `${pct(top.ctrLift - 1)} / ${pct(top.cvrLift - 1)}` },
              {
                label: 'Evidence base',
                value: `${top.assets} assets · ${top.impressions.toLocaleString('en-GB')} impressions`,
              },
            ]
          : []),
        ...(replaced && loserEffect
          ? [
              {
                label: `${CLAIM_LABEL[loserEffect.claim]} — value/impr lift`,
                value: pct(loserEffect.vpiLift - 1),
              },
            ]
          : []),
        { label: 'Ad group value', value: `${money(value)}/mo` },
      ],
      actions,
      assumptions: [
        'Lifts are regression estimates with ad-group fixed effects; co-occurring claims are separated, but a claim never tested alone in an intent is not scored.',
        "A new headline is assumed to take 25% of serves. Google's rotation decides the real share.",
      ],
    })
  }
  return recs.sort((a, b) => b.monthlyImpact - a.monthlyImpact)
}
