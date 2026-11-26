import type { Intent, Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import type { Ledger } from '../ledger'
import { monthly } from '../ledger'
import type { ClaimEffect, Genome } from './genome'
import { CLAIM_LABEL, NEEDS_SUBSTANTIATION, NOT_TRANSFERABLE, extractClaims, type Claim } from '../claims'
import { SERP_LIMITS, metaFits, textWidthPx, titleFits, trimToFit } from '../pixel'
import { formatMoney, pct, stableId, titleCase } from '../normalise'

/**
 * ENGINE 3 — Paid → organic transfer, and the SERP portfolio.
 *
 * SEO has no fast A/B test. A title change takes weeks to be recrawled and
 * weeks more to read, one page at a time. Paid search runs thousands of
 * copy trials a day on the same audience typing the same words, and the
 * genome has already distilled them into claims that win for each intent.
 *
 * So the ad account becomes SEO's test lab:
 *   – TRANSFER: a page ranking for transactional searches whose title makes
 *     none of the promises that win for transactional searches gets a new
 *     title and meta, built from the exact words that won in the ads.
 *   – PORTFOLIO: when your ad and your organic listing sit on the same
 *     results page making the same promise, one of them is wasted. The ad is
 *     steered to carry the complementary winning claim instead, so the two
 *     listings together say more than either alone.
 */

/** Organic CTR response to a claim is assumed to be half the paid response. */
export const TRANSFER_DISCOUNT = 0.5
/** A claim must not lose conversions to be transferred — the clickbait guard. */
const MIN_CVR_LIFT = 0.97
const MIN_CTR_LIFT = 1.03

function transferable(e: ClaimEffect): boolean {
  return (
    e.status === 'winner' &&
    !NOT_TRANSFERABLE.has(e.claim) &&
    e.ctrLift >= MIN_CTR_LIFT &&
    e.cvrLift >= MIN_CVR_LIFT
  )
}

export interface PageRewrite {
  url: string
  intent: Intent
  primaryQuery: string
  current: { title: string; meta: string; claims: Claim[]; titlePx: number }
  proposed: { title: string; meta: string; claims: Claim[]; titlePx: number }
  addedClaim: ClaimEffect
  /** Share of the page's organic impressions from the intent the claim was proven on. */
  intentShare: number
  monthlyOrganicClicks: number
  substantiate: string[]
  blocked: string | null
}

export function proposeRewrites(input: SerpTwinInput, ledger: Ledger, genome: Genome): PageRewrite[] {
  const out: PageRewrite[] = []
  const banned = (input.bannedTerms ?? []).map((t) => t.toLowerCase())

  const sharing = sharedTitleNonKeepers(input, ledger)
  for (const page of input.pages) {
    // A page whose title is shared with others first needs its own title (duplicateTitleRecommendations).
    if (sharing.has(page.url)) continue
    const queries = ledger.entries.filter((e) => e.organic.topPage === page.url && e.organic.impressions > 0)
    if (queries.length === 0) continue
    const votes = new Map<Intent, number>()
    for (const q of queries) votes.set(q.intent, (votes.get(q.intent) ?? 0) + q.organic.impressions)
    const total = [...votes.values()].reduce((a, b) => a + b, 0)
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1])
    // Brand searchers have already chosen; a persuasive title on a login or home page is noise.
    if (ranked[0]![0] === 'navigational') continue

    // A page often serves two intents. Any intent with at least a quarter of its impressions
    // may lend it a claim, largest share first.
    const currentClaims = extractClaims(`${page.title} ${page.metaDescription}`)
    let intent: Intent | null = null
    let add: ClaimEffect | undefined
    for (const [it, n] of ranked) {
      if (it === 'navigational' || n / total < 0.25) continue
      add = (genome.byIntent.get(it) ?? [])
        .filter(transferable)
        .sort((a, b) => b.ctrLift - a.ctrLift)
        .find((e) => !currentClaims.includes(e.claim) && e.exemplar)
      if (add) {
        intent = it
        break
      }
    }
    if (!add || !intent) continue
    const intentShare = (votes.get(intent) ?? 0) / total

    const primary =
      [...queries]
        .filter((q) => q.intent === intent)
        .sort((a, b) => b.organic.impressions - a.organic.impressions)[0] ?? queries[0]!
    const brand = input.brand.name

    // Transfer adds a claim; it never changes which keyword the title targets. The head of
    // the current title is what ranks today, so it is kept verbatim.
    const head = page.title.split(/\s[|–—-]\s/)[0]!.trim()
    const hasBrand = head.toLowerCase().includes(brand.toLowerCase())
    // A head that is only the brand name carries no keyword to keep; rewriting it would drop
    // what the page ranks for. That needs a person, not a template.
    if (head.toLowerCase() === brand.toLowerCase()) continue

    const serving = new Set(queries.flatMap((q) => q.paid.adGroupIds))
    // Try the proven headlines for this claim, best first, until one fits beside the head.
    const carriers = [
      ...new Set(
        genome.assets
          .filter(
            (a) =>
              a.intent === intent &&
              a.asset.field === 'HEADLINE' &&
              a.claims.includes(add.claim) &&
              a.claims.every((c) => !NOT_TRANSFERABLE.has(c)),
          )
          // The page's own ad groups first: their winning words were proven on its own searches.
          .sort(
            (a, b) =>
              Number(serving.has(b.asset.adGroupId)) - Number(serving.has(a.asset.adGroupId)) ||
              b.logVpi - a.logVpi,
          )
          .map((a) => a.asset.text.replace(/[.!]+$/, '')),
      ),
    ]
    let title: string | undefined
    let phrase = ''
    for (const p of carriers) {
      const candidates = [
        ...(hasBrand ? [] : [`${head} — ${p} | ${brand}`]),
        `${head} | ${p}`,
        `${head}: ${p}`,
      ]
      title = candidates.find(titleFits)
      if (title) {
        phrase = p
        break
      }
    }
    if (!title) continue // never truncate a proven phrase to make it fit

    // Meta: whole sentences only — the proven description first, then the page's own words.
    const servingAdGroups = serving
    const desc = genome.assets
      .filter((a) => a.intent === intent && a.asset.field === 'DESCRIPTION' && a.claims.includes(add.claim))
      .sort(
        (a, b) =>
          Number(servingAdGroups.has(b.asset.adGroupId)) - Number(servingAdGroups.has(a.asset.adGroupId)) ||
          b.logVpi - a.logVpi,
      )[0]
    const lead = (desc ? desc.asset.text : `${phrase}.`).trim()
    const meta = composeMeta([...sentences(lead), ...sentences(page.metaDescription)])

    const hit = banned.find((b) => `${title} ${meta}`.toLowerCase().includes(b))
    out.push({
      url: page.url,
      intent,
      primaryQuery: primary.display,
      current: {
        title: page.title,
        meta: page.metaDescription,
        claims: currentClaims,
        titlePx: textWidthPx(page.title, SERP_LIMITS.titleFontPx),
      },
      proposed: {
        title,
        meta,
        claims: extractClaims(`${title} ${meta}`),
        titlePx: textWidthPx(title, SERP_LIMITS.titleFontPx),
      },
      addedClaim: add,
      intentShare,
      monthlyOrganicClicks: monthly(
        queries.reduce((s, q) => s + q.organic.clicks, 0),
        ledger.window.days,
      ),
      substantiate: NEEDS_SUBSTANTIATION.has(add.claim)
        ? [`The page itself must state “${phrase}” — a title may not promise what the page does not show.`]
        : [],
      blocked: hit ? `Contains banned term “${hit}”` : null,
    })
  }
  return out
}

export function transferRecommendations(
  input: SerpTwinInput,
  ledger: Ledger,
  genome: Genome,
  settings: SerpTwinSettings,
): Recommendation[] {
  const money = (n: number) => formatMoney(n, settings.currency)
  const recs: Recommendation[] = []

  // Organic value per click ≈ paid value per click on the same searches.
  const vpc = (keys: string[]) => {
    let v = 0,
      c = 0
    for (const k of keys) {
      const e = ledger.byKey.get(k)
      if (e) {
        v += e.paid.value
        c += e.paid.clicks
      }
    }
    return c > 0 ? v / c : 0
  }

  for (const rw of proposeRewrites(input, ledger, genome)) {
    if (rw.blocked) continue
    const keys = ledger.entries.filter((e) => e.organic.topPage === rw.url).map((e) => e.key)
    const valuePerClick = vpc(keys)
    // No paid conversions on this page's searches means no evidence the clicks are worth anything.
    if (valuePerClick <= 0) continue
    const gain =
      rw.monthlyOrganicClicks *
      rw.intentShare *
      (rw.addedClaim.ctrLift - 1) *
      TRANSFER_DISCOUNT *
      valuePerClick
    recs.push({
      id: `tr-${stableId(rw.url, rw.addedClaim.claim)}`,
      engine: 'transfer',
      title: `Carry the winning “${CLAIM_LABEL[rw.addedClaim.claim]}” claim into ${new URL(rw.url).pathname}`,
      summary: `${pct(rw.intentShare)} of this page's impressions come from ${rw.intent} searches like “${rw.primaryQuery}”. In your ads, ${CLAIM_LABEL[rw.addedClaim.claim].toLowerCase()} lifts CTR ${pct(rw.addedClaim.ctrLift - 1)} on exactly these searches, and conversion rate ${rw.addedClaim.cvrLift >= 1 ? `rises ${pct(rw.addedClaim.cvrLift - 1)} with it` : `holds (${pct(rw.addedClaim.cvrLift - 1)})`} — so the extra clicks are buyers, not curiosity. The page title makes no such promise. The rewrite keeps the title's keyword and adds the words that already won in paid.`,
      monthlyImpact: gain,
      confidence: 'hypothesis',
      evidence: [
        { label: 'Current title', value: `${rw.current.title} (${Math.round(rw.current.titlePx)}px)` },
        {
          label: 'Proposed title',
          value: `${rw.proposed.title} (${Math.round(rw.proposed.titlePx)}px of ${SERP_LIMITS.titlePx})`,
        },
        { label: 'Proposed meta', value: rw.proposed.meta },
        {
          label: 'Paid CTR / CVR lift',
          value: `${pct(rw.addedClaim.ctrLift - 1)} / ${pct(rw.addedClaim.cvrLift - 1)}`,
        },
        {
          label: 'Proven in',
          value: `${rw.addedClaim.assets} ad assets, ${rw.addedClaim.impressions.toLocaleString('en-GB')} impressions`,
        },
        { label: 'Organic clicks', value: `${Math.round(rw.monthlyOrganicClicks)}/mo` },
      ],
      actions: [
        {
          kind: 'update_page_meta',
          description: `Update <title> and meta description on ${rw.url}`,
          payload: {
            url: rw.url,
            title: rw.proposed.title,
            metaDescription: rw.proposed.meta,
            measure: {
              metric: 'organic CTR at constant position',
              window: '28 days before vs 28 days after recrawl',
            },
          },
          undo: { url: rw.url, title: rw.current.title, metaDescription: rw.current.meta },
          requiresApproval: true,
        },
      ],
      assumptions: [
        `Organic CTR response assumed to be ${pct(TRANSFER_DISCOUNT)} of the paid response — a hypothesis the before/after read tests.`,
        ...rw.substantiate,
      ],
    })
  }

  recs.push(...duplicateTitleRecommendations(input, ledger))

  // ── SERP portfolio: ad and organic listing saying the same thing.
  const meta = new Map(input.pages.map((p) => [p.url, p]))
  const MEANINGFUL = (c: Claim) => c !== 'cta' && c !== 'specificity'
  const byAdGroup = new Map<
    string,
    { queries: string[]; clicks: number; value: number; overlap: number; organic: Claim[]; ad: Claim[] }
  >()

  for (const e of ledger.entries) {
    if (
      e.paid.impressions === 0 ||
      e.organic.position === null ||
      e.organic.position > 5 ||
      !e.organic.topPage
    )
      continue
    const page = meta.get(e.organic.topPage)
    if (!page) continue
    const orgClaims = extractClaims(`${page.title} ${page.metaDescription}`).filter(MEANINGFUL)
    for (const ag of e.paid.adGroupIds) {
      const top3 = genome.assets
        .filter((a) => a.asset.adGroupId === ag && a.asset.field === 'HEADLINE')
        .sort((a, b) => b.asset.impressions - a.asset.impressions)
        .slice(0, 3)
      const adClaims = [...new Set(top3.flatMap((a) => a.claims))].filter(MEANINGFUL)
      const union = new Set([...adClaims, ...orgClaims])
      if (union.size < 2) continue
      const inter = adClaims.filter((c) => orgClaims.includes(c)).length
      const j = inter / union.size
      if (j < 0.5) continue
      const slot = byAdGroup.get(ag) ?? {
        queries: [],
        clicks: 0,
        value: 0,
        overlap: 0,
        organic: orgClaims,
        ad: adClaims,
      }
      slot.queries.push(e.display)
      slot.clicks += e.paid.clicks
      slot.value += e.paid.value
      slot.overlap = Math.max(slot.overlap, j)
      byAdGroup.set(ag, slot)
    }
  }

  const agName = new Map(input.adGroups.map((g) => [g.adGroupId, g.name]))
  for (const [ag, s] of byAdGroup) {
    const intent = genome.adGroupIntent.get(ag)
    const effects = intent ? (genome.byIntent.get(intent) ?? []) : []
    const comp = effects.find(
      (e) =>
        e.status === 'winner' &&
        !s.organic.includes(e.claim) &&
        !s.ad.includes(e.claim) &&
        e.exemplar &&
        e.exemplar.field === 'HEADLINE' &&
        e.exemplar.text.length <= SERP_LIMITS.adHeadlineChars,
    )
    if (!comp) continue
    const vpcAg = s.clicks > 0 ? s.value / s.clicks : 0
    const gain = monthly(s.clicks, ledger.window.days) * (comp.ctrLift - 1) * TRANSFER_DISCOUNT * vpcAg
    recs.push({
      id: `pf-${stableId(ag, comp.claim)}`,
      engine: 'transfer',
      title: `${agName.get(ag) ?? ag}: your ad and your organic listing are saying the same thing`,
      summary: `On ${s.queries.length} searches you hold both an ad and a top-five organic listing, and ${pct(s.overlap)} of their claims overlap (${s.ad.map((c) => CLAIM_LABEL[c]).join(', ')}). Two listings, one message. Pin a headline that adds ${CLAIM_LABEL[comp.claim].toLowerCase()} — a claim the organic listing does not make and that wins for ${intent} searches.`,
      monthlyImpact: gain,
      confidence: 'hypothesis',
      evidence: [
        {
          label: 'Shared SERPs',
          value: s.queries
            .slice(0, 4)
            .map((q) => `“${q}”`)
            .join(', '),
        },
        { label: 'Claim overlap (Jaccard)', value: pct(s.overlap) },
        { label: 'Organic says', value: s.organic.map((c) => CLAIM_LABEL[c]).join(', ') || '—' },
        { label: 'Ad says', value: s.ad.map((c) => CLAIM_LABEL[c]).join(', ') || '—' },
        {
          label: `Add: ${CLAIM_LABEL[comp.claim]}`,
          value: `CTR ${pct(comp.ctrLift - 1)}, value/impr ${pct(comp.vpiLift - 1)}`,
        },
      ],
      actions: [
        {
          kind: 'pin_headline',
          description: `Pin “${comp.exemplar!.text}” to headline position 2 in ${agName.get(ag) ?? ag}`,
          payload: { adGroupId: ag, text: comp.exemplar!.text, pinnedField: 'HEADLINE_2' },
          undo: { kind: 'unpin_headline', adGroupId: ag, text: comp.exemplar!.text },
          requiresApproval: true,
        },
      ],
      assumptions: [
        'Only searches where both listings appear (organic top five, ad served) count.',
        'Pinning narrows RSA rotation; position 2 keeps headline 1 free for the keyword.',
        `Gain assumes ${pct(TRANSFER_DISCOUNT)} of the claim's measured CTR lift carries onto a shared SERP.`,
      ],
    })
  }

  return recs
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (/[.!?]$/.test(x) ? x : `${x}.`))
}

/** Greedy: add whole sentences while the snippet still fits; trim only if the first alone does not. */
export function composeMeta(parts: string[]): string {
  const seen = new Set<string>()
  let out = ''
  for (const p of parts) {
    const k = p.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    const next = out ? `${out} ${p}` : p
    if (metaFits(next)) out = next
    else if (!out) return trimToFit(p, metaFits)
  }
  return out
}

/**
 * Site check: several pages sharing one <title>. Google then has no way to tell
 * them apart, often rewrites the titles itself, and the pages compete with
 * each other. Each page gets a title from its own H1 (or, without one, from the
 * search it already ranks best for). The page with the most organic
 * impressions keeps the shared title. A page with neither is left for a person
 * to name rather than guessed.
 */
/** The home page keeps a shared title; otherwise the page with the most organic impressions does. */
function pickKeeper(urls: string[], impr: (u: string) => number): string {
  const home = urls.find((u) => new URL(u).pathname === '/')
  return home ?? [...urls].sort((a, b) => impr(b) - impr(a))[0]!
}

function sharedTitleNonKeepers(input: SerpTwinInput, ledger: Ledger): Set<string> {
  const out = new Set<string>()
  const impr = (url: string) =>
    ledger.entries.filter((e) => e.organic.topPage === url).reduce((a, e) => a + e.organic.impressions, 0)
  const groups = new Map<string, string[]>()
  for (const p of input.pages) {
    const k = p.title.trim().toLowerCase()
    groups.set(k, [...(groups.get(k) ?? []), p.url])
  }
  for (const urls of groups.values()) {
    if (urls.length < 2) continue
    const keeper = pickKeeper(urls, impr)
    for (const u of urls) if (u !== keeper) out.add(u)
  }
  return out
}

export function duplicateTitleRecommendations(input: SerpTwinInput, ledger: Ledger): Recommendation[] {
  const brand = input.brand.name
  const groups = new Map<string, typeof input.pages>()
  for (const p of input.pages) {
    const k = p.title.trim().toLowerCase()
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  const recs: Recommendation[] = []
  for (const pages of groups.values()) {
    if (pages.length < 2) continue
    const impr = (url: string) =>
      ledger.entries.filter((e) => e.organic.topPage === url).reduce((a, e) => a + e.organic.impressions, 0)
    // A search names the page only when it brings most of the page's impressions;
    // a hub page (an FAQ, say) ranks for many things and is better named by hand.
    const topQuery = (url: string) => {
      const top = ledger.entries
        .filter((e) => e.organic.topPage === url && e.intent !== 'navigational')
        .sort((a, b) => b.organic.impressions - a.organic.impressions)[0]
      return top && top.organic.impressions >= 0.5 * impr(url) ? top.display : undefined
    }
    const keeperUrl = pickKeeper(pages.map((p) => p.url), impr)
    const keeper = pages.find((p) => p.url === keeperUrl)!
    const sharedMeta = new Set(pages.map((p) => p.metaDescription.trim())).size === 1
    const rows: { url: string; from: string; title: string | null }[] = []
    for (const p of pages) {
      if (p === keeper) continue
      const src = p.h1?.trim() ? { from: 'H1', text: p.h1.trim().replace(/[?.!]+$/, (m) => (m.includes('?') ? '?' : '')) } : null
      const q = topQuery(p.url)
      const base = src ?? (q ? { from: 'top search', text: titleCase(q) } : null)
      if (!base) {
        rows.push({ url: p.url, from: 'none', title: null })
        continue
      }
      const title = [`${base.text} | ${brand}`, base.text].find(titleFits) ?? trimToFit(base.text, titleFits)
      rows.push({ url: p.url, from: base.from, title })
    }
    const proposals = rows.filter((r) => r.title)
    const path = (u: string) => new URL(u).pathname
    recs.push({
      id: `tr-dup-${stableId(keeper.title)}`,
      engine: 'transfer',
      title: `${pages.length} pages share one title${sharedMeta ? ' and meta description' : ''}`,
      summary: `Every one of these pages is titled “${keeper.title}”. Search engines cannot tell them apart, so they compete with each other and Google often rewrites the titles itself. ${path(keeper.url) === '/' ? 'The home page' : `${path(keeper.url)} (the page with the most organic impressions)`} keeps the current title; the others get titles from their own headings.${sharedMeta ? ' The meta descriptions are identical too: write one per page. They are left for you rather than invented.' : ''}`,
      monthlyImpact: 0,
      confidence: 'measured',
      evidence: [
        {
          label: 'Shared title',
          value: `${keeper.title} (${Math.round(textWidthPx(keeper.title, SERP_LIMITS.titleFontPx))}px${titleFits(keeper.title) ? '' : `, over the ${SERP_LIMITS.titlePx}px Google shows, so it is cut off`})`,
        },
        { label: 'Pages', value: pages.map((p) => path(p.url)).join(', ') },
        ...rows.map((r) => ({
          label: path(r.url),
          value: r.title ? `${r.title}  (from its ${r.from})` : 'No H1, and no single search it ranks for: needs a title written by hand',
        })),
      ],
      actions: proposals.map((r) => {
        const page = pages.find((p) => p.url === r.url)!
        return {
          kind: 'update_page_meta' as const,
          description: `Give ${path(r.url)} its own title`,
          payload: {
            url: r.url,
            title: r.title!,
            metaDescription: page.metaDescription,
            measure: { metric: 'organic impressions and CTR per page', window: '28 days before vs 28 days after recrawl' },
          },
          undo: { url: r.url, title: page.title, metaDescription: page.metaDescription },
          requiresApproval: true,
        }
      }),
      assumptions: [
        'No money figure is put on this. The gain is that each page can rank for its own topic; measure it page by page before and after.',
      ],
    })
  }
  return recs
}
