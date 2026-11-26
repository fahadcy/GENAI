import type { BusinessProfile, Lead, Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import { contentTokens, formatMoney, microsToMoney, pct, queryKey, stableId } from '../normalise'
import { monthly } from '../ledger'

/**
 * ENGINE 5 — Why leads fail.
 *
 * Google Ads counts every form submission as the same conversion, so a
 * campaign bringing forty people who want a service you do not sell looks
 * exactly as good as one bringing forty buyers. This engine takes each
 * enquiry and what became of it, and says which of these it was:
 *
 *   spam              — bot or junk, from form signals the business already has
 *   wrong_service     — wants something the business does not offer
 *   out_of_area       — somewhere the business cannot deliver
 *   missed_follow_up  — suitable, but nobody replied in time
 *   unreachable       — suitable, contacted repeatedly, never answered.
 *                       Not a bad lead. Never uploaded to Google as one.
 *   lost_*            — a real prospect lost, for a reason read from the
 *                       salesperson's own words (price, timing, competitor, fit)
 *   won / open
 *
 * Every classification carries the evidence behind it, so a disputed one can
 * be checked and overruled. Rules only — no model — so the same enquiry is
 * classified the same way next week.
 */

export type LeadCategory =
  | 'spam'
  | 'wrong_service'
  | 'out_of_area'
  | 'unsuitable'
  | 'won'
  | 'missed_follow_up'
  | 'unreachable'
  | 'lost_price'
  | 'lost_timing'
  | 'lost_competitor'
  | 'lost_fit'
  | 'lost_other'
  | 'open'

export const LEAD_CATEGORY_LABEL: Record<LeadCategory, string> = {
  spam: 'Spam or junk',
  wrong_service: 'Wants something you do not offer',
  out_of_area: 'Outside your service area',
  unsuitable: 'Marked unsuitable by sales',
  won: 'Became a customer',
  missed_follow_up: 'Suitable, but not followed up in time',
  unreachable: 'Suitable, never answered',
  lost_price: 'Lost on price',
  lost_timing: 'Lost on timing',
  lost_competitor: 'Lost to a competitor',
  lost_fit: 'Lost on fit',
  lost_other: 'Lost, other reason',
  open: 'Still open',
}

/** Categories that mean the enquiry was never a real prospect. */
export const NOT_A_PROSPECT: ReadonlySet<LeadCategory> = new Set([
  'spam',
  'wrong_service',
  'out_of_area',
  'unsuitable',
])

export interface ClassifiedLead {
  lead: Lead
  category: LeadCategory
  evidence: string[]
  serviceId: string | null
  /** The not-offered phrase that matched, for wrong_service. */
  matchedPhrase?: string
  respondedInSla: boolean | null
  responseHours: number | null
}

// ───────────────────────────── Rules

const LOST_RULES: { category: LeadCategory; test: RegExp }[] = [
  {
    category: 'lost_competitor',
    test: /\b(went with|chose|signed with|competitor|another (provider|supplier|agency|company)|elsewhere|stayed with)\b/i,
  },
  {
    category: 'lost_price',
    test: /\b(price|pricing|expensive|cost|budget|afford|cheaper|fee|fees|quote too high|too much)\b/i,
  },
  {
    category: 'lost_timing',
    test: /\b(not now|next (year|quarter|month)|timing|later|too soon|wait|booked|start (this|next) month|lead time)\b/i,
  },
  {
    category: 'lost_fit',
    test: /\b(not a fit|doesn'?t need|too small|too big|missing|integration|feature|requirement|not suitable)\b/i,
  },
]
const UNREACHABLE =
  /\b(no answer|no response|didn'?t (reply|answer|respond)|unreachable|voicemail|ghosted|never replied|couldn'?t reach)\b/i
const LINKS = /https?:\/\/|www\./gi

export function lostCategory(reason: string | null | undefined): LeadCategory {
  if (!reason) return 'lost_other'
  for (const r of LOST_RULES) if (r.test.test(reason)) return r.category
  return 'lost_other'
}

function phraseIn(text: string, phrase: string): boolean {
  const p = queryKey(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)${p}(s)?(\\s|$)`).test(queryKey(text))
}

export function inferService(lead: Lead, profile: BusinessProfile): string | null {
  if (lead.serviceId && profile.services.some((s) => s.id === lead.serviceId)) return lead.serviceId
  // A paid enquiry belongs to the service whose ad was clicked: that is where the money went.
  const byAdGroup = profile.services.find((s) => lead.adGroupId && s.adGroupIds.includes(lead.adGroupId))
  if (byAdGroup) return byAdGroup.id
  const byPage = profile.services.find((s) => lead.landingPage && s.landingPages.includes(lead.landingPage))
  if (byPage) return byPage.id
  const text = `${lead.searchTerm ?? ''} ${lead.message}`
  let best: { id: string; hits: number } | null = null
  for (const s of profile.services) {
    const hits = s.keywords.filter((k) => phraseIn(text, k)).length
    if (hits > 0 && (!best || hits > best.hits)) best = { id: s.id, hits }
  }
  return best?.id ?? null
}

/** Buying words that show up in good searches too; never proposed as negatives. */
const NEVER_NEGATE = new Set([
  'buy',
  'purchase',
  'price',
  'pricing',
  'cost',
  'quote',
  'uk',
  'near',
  'service',
  'services',
  'software',
  'platform',
  'best',
  'company',
  'provider',
])

export function inServiceArea(lead: Lead, profile: BusinessProfile): boolean | null {
  if (!lead.location || profile.serviceAreas.length === 0) return null
  const { country, area } = lead.location
  return profile.serviceAreas.some((a) => {
    const [c, pa] = a.split(':')
    return c === country && (!pa || (area ?? '').toUpperCase() === pa.toUpperCase())
  })
}

/**
 * Working hours between two instants, Monday–Friday 09:00–17:30 UK time.
 * A Friday-evening enquiry answered on Monday morning waited one hour, not
 * sixty — the sales team is judged against the hours they actually work.
 */
export function workingHoursBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime()
  const to = new Date(toIso).getTime()
  if (!(to > from)) return 0
  let t = from
  let ms = 0
  const step = 15 * 60_000
  while (t < to && ms < 1000 * 3_600_000) {
    const d = new Date(t)
    const h = ukHour(d)
    const dow = ukDay(d)
    if (dow >= 1 && dow <= 5 && h >= 9 && h < 17.5) ms += Math.min(step, to - t)
    t += step
  }
  return ms / 3_600_000
}

/** UK local hour as a decimal, handling BST (last Sunday of March to last Sunday of October). */
function ukOffsetHours(d: Date): number {
  const y = d.getUTCFullYear()
  const lastSunday = (m: number) => {
    const x = new Date(Date.UTC(y, m + 1, 0))
    x.setUTCDate(x.getUTCDate() - x.getUTCDay())
    return x
  }
  const start = lastSunday(2).getTime() + 3_600_000
  const end = lastSunday(9).getTime() + 3_600_000
  return d.getTime() >= start && d.getTime() < end ? 1 : 0
}
function ukHour(d: Date): number {
  const local = new Date(d.getTime() + ukOffsetHours(d) * 3_600_000)
  return local.getUTCHours() + local.getUTCMinutes() / 60
}
function ukDay(d: Date): number {
  return new Date(d.getTime() + ukOffsetHours(d) * 3_600_000).getUTCDay()
}
export function ukTimeBucket(iso: string): 'weekday_hours' | 'weekday_evening' | 'weekend' {
  const d = new Date(iso)
  const dow = ukDay(d)
  if (dow === 0 || dow === 6) return 'weekend'
  const h = ukHour(d)
  return h >= 9 && h < 17.5 ? 'weekday_hours' : 'weekday_evening'
}

export function classifyLead(
  lead: Lead,
  profile: BusinessProfile,
  context: { duplicateOf?: string } = {},
): ClassifiedLead {
  const evidence: string[] = []
  const serviceId = inferService(lead, profile)
  const responseHours = lead.firstResponseAt
    ? workingHoursBetween(lead.receivedAt, lead.firstResponseAt)
    : null
  const respondedInSla = lead.firstResponseAt ? (responseHours ?? 0) <= profile.followUpSlaHours : false
  const base = { lead, serviceId, respondedInSla, responseHours }

  // Spam — one strong signal, or two weak ones. A salesperson's "spam" is trusted outright.
  const s = lead.signals ?? {}
  const weak: string[] = []
  if (typeof s.secondsToSubmit === 'number' && s.secondsToSubmit < 3)
    weak.push(`form completed in ${s.secondsToSubmit}s`)
  if (s.disposableEmail) weak.push('disposable email address')
  if (s.phoneValid === false) weak.push('phone number not valid')
  const links = (lead.message.match(LINKS) ?? []).length
  if (links >= 2) weak.push(`${links} links in the message`)
  if (context.duplicateOf) weak.push('same details as another enquiry minutes earlier')
  if (lead.outcome === 'spam')
    return { ...base, category: 'spam', evidence: ['Marked spam by sales', ...weak] }
  if (s.honeypotFilled)
    return {
      ...base,
      category: 'spam',
      evidence: ['Hidden form field filled in, which only bots see', ...weak],
    }
  if (weak.length >= 2) return { ...base, category: 'spam', evidence: weak }

  // Wrong service — a phrase the business has said it does not offer, in the search or the message.
  for (const phrase of profile.notOffered) {
    const inTerm = lead.searchTerm ? phraseIn(lead.searchTerm, phrase) : false
    const inMsg = phraseIn(lead.message, phrase)
    if (inTerm || inMsg) {
      evidence.push(
        `${inTerm ? `searched “${lead.searchTerm}”` : ''}${inTerm && inMsg ? ' and ' : ''}${inMsg ? `wrote “${excerpt(lead.message, phrase)}”` : ''}`,
      )
      evidence.push(`“${phrase}” is on your list of things you do not offer`)
      return { ...base, category: 'wrong_service', evidence, matchedPhrase: phrase }
    }
  }

  const area = inServiceArea(lead, profile)
  if (area === false) {
    return {
      ...base,
      category: 'out_of_area',
      evidence: [
        `Enquiry from ${lead.location!.country}${lead.location!.area ? ` (${lead.location!.area})` : ''}, outside ${profile.serviceAreas.join(', ')}`,
      ],
    }
  }

  if (lead.outcome === 'won')
    return {
      ...base,
      category: 'won',
      evidence: [`Became a customer${lead.value ? ` worth ${formatMoney(lead.value)}` : ''}`],
    }
  if (lead.outcome === 'unqualified') {
    return {
      ...base,
      category: 'unsuitable',
      evidence: [`Marked unsuitable by sales${lead.lostReason ? `: “${lead.lostReason}”` : ''}`],
    }
  }

  // From here the enquiry was a real prospect. Missing it is our failure, not theirs.
  const tried = lead.contactAttempts
  const silent = UNREACHABLE.test(lead.lostReason ?? '')
  if (!respondedInSla && tried < profile.unreachableAfterAttempts) {
    return {
      ...base,
      category: 'missed_follow_up',
      evidence: [
        lead.firstResponseAt
          ? `First reply after ${responseHours!.toFixed(1)} working hours; target is ${profile.followUpSlaHours}`
          : 'No reply recorded',
        `Arrived ${bucketLabel(ukTimeBucket(lead.receivedAt))}`,
      ],
    }
  }
  if (tried >= profile.unreachableAfterAttempts && (silent || lead.outcome === 'open')) {
    return {
      ...base,
      category: 'unreachable',
      evidence: [`${tried} contact attempts, no answer`, 'Not treated as a bad lead'],
    }
  }
  if (lead.outcome === 'lost') {
    const cat = silent ? 'unreachable' : lostCategory(lead.lostReason)
    return {
      ...base,
      category: cat,
      evidence: [lead.lostReason ? `Sales noted: “${lead.lostReason}”` : 'Lost, no reason recorded'],
    }
  }
  return { ...base, category: 'open', evidence: ['No outcome recorded yet'] }
}

function excerpt(text: string, phrase: string): string {
  const i = text.toLowerCase().indexOf(phrase.split(' ')[0]!.toLowerCase())
  const start = Math.max(0, i - 25)
  const cut = text.slice(start, start + 80).trim()
  return `${start > 0 ? '…' : ''}${cut}${start + 80 < text.length ? '…' : ''}`
}

function bucketLabel(b: ReturnType<typeof ukTimeBucket>): string {
  return b === 'weekend'
    ? 'at the weekend'
    : b === 'weekday_evening'
      ? 'on a weekday outside working hours'
      : 'during working hours'
}

// ───────────────────────────── Diagnosis

export interface LeadUnit {
  key: string
  label: string
  kind: 'ad_group' | 'source'
  enquiries: number
  counts: Partial<Record<LeadCategory, number>>
  prospects: number
  customers: number
  cost: number
  costPerEnquiry: number | null
  costPerProspect: number | null
  costPerCustomer: number | null
}

export interface OfflineConversionRow {
  gclid: string
  conversionName: 'Qualified enquiry' | 'Customer'
  conversionTime: string
  value: number
  leadId: string
}

export interface LeadDiagnosis {
  total: number
  counts: Record<LeadCategory, number>
  classified: ClassifiedLead[]
  units: LeadUnit[]
  /** Enquiries Google Ads counted as conversions that were never real prospects. */
  paidEnquiries: number
  paidNotProspects: number
  winRateAnswered: number | null
  winRateMissed: number | null
  offlineRows: OfflineConversionRow[]
  days: number
}

export function diagnoseLeads(input: SerpTwinInput, days: number): LeadDiagnosis | null {
  const profile = input.business
  const leads = input.leads ?? []
  if (!profile || leads.length === 0) return null

  // Duplicates: same email or phone within 30 minutes of an earlier enquiry.
  const sorted = [...leads].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  const lastSeen = new Map<string, { id: string; t: number }>()
  const dupOf = new Map<string, string>()
  for (const l of sorted) {
    const t = new Date(l.receivedAt).getTime()
    for (const key of [l.email?.toLowerCase(), l.phone].filter(Boolean) as string[]) {
      const prev = lastSeen.get(key)
      if (prev && t - prev.t < 30 * 60_000) dupOf.set(l.id, prev.id)
      lastSeen.set(key, { id: l.id, t })
    }
  }

  const classified = sorted.map((l) => classifyLead(l, profile, { duplicateOf: dupOf.get(l.id) }))
  const counts = Object.fromEntries(Object.keys(LEAD_CATEGORY_LABEL).map((k) => [k, 0])) as Record<
    LeadCategory,
    number
  >
  for (const c of classified) counts[c.category]++

  // Cost per ad group over the window, for cost per real prospect.
  const agCost = new Map<string, number>()
  for (const r of input.searchTerms)
    agCost.set(r.adGroupId, (agCost.get(r.adGroupId) ?? 0) + microsToMoney(r.costMicros))
  const agName = new Map(input.adGroups.map((g) => [g.adGroupId, g.name]))

  const unitMap = new Map<string, LeadUnit>()
  for (const c of classified) {
    const paid = c.lead.source === 'ppc' && c.lead.adGroupId
    const key = paid ? `ag:${c.lead.adGroupId}` : `src:${c.lead.source}`
    let u = unitMap.get(key)
    if (!u) {
      u = {
        key,
        label: paid
          ? (agName.get(c.lead.adGroupId!) ?? c.lead.adGroupId!)
          : `${c.lead.source[0]!.toUpperCase()}${c.lead.source.slice(1)} (not paid)`,
        kind: paid ? 'ad_group' : 'source',
        enquiries: 0,
        counts: {},
        prospects: 0,
        customers: 0,
        cost: paid ? (agCost.get(c.lead.adGroupId!) ?? 0) : 0,
        costPerEnquiry: null,
        costPerProspect: null,
        costPerCustomer: null,
      }
      unitMap.set(key, u)
    }
    u.enquiries++
    u.counts[c.category] = (u.counts[c.category] ?? 0) + 1
    if (!NOT_A_PROSPECT.has(c.category)) u.prospects++
    if (c.category === 'won') u.customers++
  }
  const units = [...unitMap.values()].map((u) => ({
    ...u,
    costPerEnquiry: u.cost > 0 && u.enquiries > 0 ? u.cost / u.enquiries : null,
    costPerProspect: u.cost > 0 && u.prospects > 0 ? u.cost / u.prospects : null,
    costPerCustomer: u.cost > 0 && u.customers > 0 ? u.cost / u.customers : null,
  }))
  units.sort((a, b) => b.cost - a.cost || b.enquiries - a.enquiries)

  const suitable = classified.filter(
    (c) => !NOT_A_PROSPECT.has(c.category) && c.category !== 'open' && c.category !== 'unreachable',
  )
  const answered = suitable.filter((c) => c.respondedInSla)
  const missed = suitable.filter((c) => !c.respondedInSla)
  const rate = (xs: ClassifiedLead[]) =>
    xs.length ? xs.filter((c) => c.category === 'won').length / xs.length : null

  const paidLeads = classified.filter((c) => c.lead.source === 'ppc')

  // Offline conversions: only verified outcomes, only with a click id. Unreachable and open
  // leads are left out — they are unknown, not bad — and junk is simply never sent.
  const offlineRows: OfflineConversionRow[] = []
  for (const c of paidLeads) {
    if (!c.lead.gclid) continue
    if (c.category === 'won') {
      offlineRows.push({
        gclid: c.lead.gclid,
        conversionName: 'Customer',
        conversionTime: c.lead.receivedAt,
        value: c.lead.value ?? 0,
        leadId: c.lead.id,
      })
    }
    if (!NOT_A_PROSPECT.has(c.category) && c.category !== 'open' && c.category !== 'unreachable') {
      offlineRows.push({
        gclid: c.lead.gclid,
        conversionName: 'Qualified enquiry',
        conversionTime: c.lead.receivedAt,
        value: 0,
        leadId: c.lead.id,
      })
    }
  }

  return {
    total: classified.length,
    counts,
    classified,
    units,
    paidEnquiries: paidLeads.length,
    paidNotProspects: paidLeads.filter((c) => NOT_A_PROSPECT.has(c.category)).length,
    winRateAnswered: rate(answered),
    winRateMissed: rate(missed),
    offlineRows,
    days,
  }
}

// ───────────────────────────── Recommendations

export function leadRecommendations(
  input: SerpTwinInput,
  d: LeadDiagnosis,
  settings: SerpTwinSettings,
): Recommendation[] {
  const profile = input.business!
  const money = (n: number) => formatMoney(n, settings.currency)
  const recs: Recommendation[] = []
  const avgMargin =
    profile.services.reduce((s, x) => s + x.marginPerCustomer, 0) / Math.max(1, profile.services.length)
  const marginOf = (id: string | null) =>
    profile.services.find((s) => s.id === id)?.marginPerCustomer ?? avgMargin
  const serviceName = (id: string | null) =>
    profile.services.find((s) => s.id === id)?.name ?? 'your services'

  // ── 1. Wrong service, grouped by ad group.
  const wrongByAg = new Map<string, ClassifiedLead[]>()
  for (const c of d.classified) {
    if (c.category !== 'wrong_service' || c.lead.source !== 'ppc' || !c.lead.adGroupId) continue
    wrongByAg.set(c.lead.adGroupId, [...(wrongByAg.get(c.lead.adGroupId) ?? []), c])
  }
  const goodTerms = d.classified
    .filter((c) => !NOT_A_PROSPECT.has(c.category) && c.lead.searchTerm)
    .map((c) => queryKey(c.lead.searchTerm!))
  for (const [ag, list] of wrongByAg) {
    const unit = d.units.find((u) => u.key === `ag:${ag}`)
    if (!unit || list.length < 3) continue
    const share = list.length / unit.enquiries
    if (share < 0.15) continue
    const phrases = countBy(list.map((c) => c.matchedPhrase!))
    const top = [...phrases.entries()].sort((a, b) => b[1] - a[1])
    // Negatives: words from the junk searches that never appear in a search that brought a real prospect.
    const candidateWords = new Map<string, number>()
    for (const c of list)
      for (const w of contentTokens(c.lead.searchTerm ?? ''))
        candidateWords.set(w, (candidateWords.get(w) ?? 0) + 1)
    const blocksGood = (w: string) => goodTerms.some((t) => t.split(' ').includes(w))
    const negatives = [...candidateWords.entries()]
      .filter(([w, n]) => n >= 2 && !blocksGood(w) && !NEVER_NEGATE.has(w))
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w)
      .slice(0, 6)
    const rejected = [...candidateWords.keys()].filter((w) => blocksGood(w)).slice(0, 4)
    const wastedMonthly = monthly(unit.cost * share, d.days)
    const page = mostCommon(list.map((c) => c.lead.landingPage).filter(Boolean) as string[])
    const svc = serviceName(inferServiceFromAg(profile, ag))
    const example =
      list.find((c) => c.lead.searchTerm && phraseIn(c.lead.message, c.matchedPhrase!)) ?? list[0]!
    recs.push({
      id: `ld-wrong-${stableId(ag)}`,
      engine: 'leads',
      title: `${unit.label}: ${pct(share)} of enquiries want something you do not offer`,
      summary: `This ad group brings people asking for ${top
        .slice(0, 2)
        .map(([p]) => `“${p}”`)
        .join(
          ' and ',
        )}, which is not what you sell. For example, someone searched “${example.lead.searchTerm}” and wrote “${example.lead.message.slice(0, 90)}${example.lead.message.length > 90 ? '…' : ''}”. Google counts every one of them as a conversion, so it is learning to find more. Block the searches and make it clear on the landing page that you offer ${svc}.`,
      monthlyImpact: wastedMonthly,
      confidence: 'measured',
      evidence: [
        { label: 'Enquiries from this ad group', value: String(unit.enquiries) },
        { label: 'Wanted something you do not offer', value: `${list.length} (${pct(share)})` },
        ...top.slice(0, 3).map(([p, n]) => ({ label: `Asked for “${p}”`, value: `${n} enquiries` })),
        { label: 'Spend on them, estimated', value: `${money(wastedMonthly)}/mo` },
        ...(rejected.length
          ? [
              {
                label: 'Words kept, because real prospects use them',
                value: rejected.map((w) => `“${w}”`).join(', '),
              },
            ]
          : []),
      ],
      actions: [
        ...(negatives.length
          ? [
              {
                kind: 'add_negative_keywords' as const,
                description: `Add phrase negatives to ${unit.label}: ${negatives.map((n) => `“${n}”`).join(', ')}`,
                payload: {
                  adGroupId: ag,
                  negatives: negatives.map((text) => ({ text, matchType: 'PHRASE' })),
                },
                undo: { kind: 'remove_negative_keywords', adGroupId: ag, negatives },
                requiresApproval: true,
              },
            ]
          : []),
        {
          kind: 'clarify_landing_page' as const,
          description: `Say plainly on ${page ?? 'the landing page'} what you do and do not offer, near the form`,
          payload: {
            url: page,
            add: `We provide ${svc}. We do not sell ${top
              .map(([p]) => p)
              .slice(0, 3)
              .join(', ')}.`,
          },
          undo: { url: page, remove: true },
          requiresApproval: true,
        },
      ],
      assumptions: [
        'Spend on these enquiries is estimated as their share of the ad group’s enquiries times its spend.',
        'Negative words are only proposed if they never appear in a search that brought a real prospect.',
      ],
    })
  }

  // ── 2. Missed follow-ups.
  const missed = d.classified.filter((c) => c.category === 'missed_follow_up')
  if (missed.length >= 3 && d.winRateAnswered !== null) {
    const buckets = countBy(missed.map((c) => ukTimeBucket(c.lead.receivedAt)))
    const worst = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0]!
    const lift = Math.max(0, d.winRateAnswered - (d.winRateMissed ?? 0))
    const margin = missed.reduce((s, c) => s + marginOf(c.serviceId), 0) / missed.length
    const impact = monthly(missed.length * lift * margin, d.days)
    recs.push({
      id: 'ld-followup',
      engine: 'leads',
      title: `${missed.length} suitable enquiries were not followed up in time`,
      summary: `These were real prospects: right service, right area, not spam. Nobody replied within ${profile.followUpSlaHours} working hours. ${pct(d.winRateAnswered)} of enquiries answered in time became customers, against ${pct(d.winRateMissed ?? 0)} of the late ones. ${worst[1]} of the ${missed.length} arrived ${bucketLabel(worst[0] as ReturnType<typeof ukTimeBucket>)}. This is lost revenue, not bad advertising, so no campaign change is suggested.`,
      monthlyImpact: impact,
      confidence: 'estimated',
      evidence: [
        { label: 'Win rate, answered in time', value: pct(d.winRateAnswered) },
        { label: 'Win rate, answered late or never', value: pct(d.winRateMissed ?? 0) },
        ...[...buckets.entries()].map(([b, n]) => ({
          label: `Missed, arrived ${bucketLabel(b as ReturnType<typeof ukTimeBucket>)}`,
          value: String(n),
        })),
        { label: 'Average profit per customer', value: money(margin) },
      ],
      actions: [
        {
          kind: 'fix_follow_up',
          description: `Alert the sales owner when an enquiry has no reply after ${Math.max(1, Math.floor(profile.followUpSlaHours / 2))} working hours, and cover ${bucketLabel(worst[0] as ReturnType<typeof ukTimeBucket>)} enquiries first thing next working morning`,
          payload: {
            alertAfterHours: Math.max(1, Math.floor(profile.followUpSlaHours / 2)),
            focus: worst[0],
          },
          undo: null,
          requiresApproval: false,
        },
      ],
      assumptions: [
        'Impact = missed enquiries × (win rate answered in time − win rate when late) × average profit per customer.',
        'Leads contacted repeatedly without an answer are counted as unreachable, not as missed and not as bad leads.',
      ],
    })
  }

  // ── 3. Spam concentration.
  for (const u of d.units) {
    const spam = u.counts.spam ?? 0
    if (spam < 5 || spam / u.enquiries < 0.12) continue
    const list = d.classified.filter(
      (c) =>
        c.category === 'spam' &&
        (u.kind === 'ad_group' ? `ag:${c.lead.adGroupId}` : `src:${c.lead.source}`) === u.key,
    )
    const reasons = countBy(
      list.flatMap((c) =>
        c.evidence.map((e) => e.replace(/\d+s$/, 'under 3s').replace(/^\d+ links/, 'links')),
      ),
    )
    const minutesEach = 6
    recs.push({
      id: `ld-spam-${stableId(u.key)}`,
      engine: 'leads',
      title: `${u.label}: ${pct(spam / u.enquiries)} of enquiries are spam`,
      summary: `${spam} enquiries from ${u.label} show clear junk signals. ${
        u.kind === 'ad_group' ? 'Google counts each one as a conversion, and each' : 'Each'
      } costs your team time. Turn on the form checks below. Spam is never sent to Google as a qualified enquiry.`,
      monthlyImpact: u.cost > 0 ? monthly((u.cost * spam) / u.enquiries, d.days) : 0,
      confidence: 'measured',
      evidence: [
        ...[...reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([r, n]) => ({ label: r, value: `${n} enquiries` })),
        {
          label: 'Staff time spent on them, estimated',
          value: `${Math.round((monthly(spam, d.days) * minutesEach) / 60)} hours a month`,
        },
      ],
      actions: [
        {
          kind: 'enable_form_checks',
          description:
            'Add a hidden honeypot field and a 3-second minimum to the enquiry form; hold flagged submissions for review instead of alerting sales',
          payload: { honeypot: true, minSeconds: 3, holdForReview: true },
          undo: { honeypot: false, minSeconds: 0, holdForReview: false },
          requiresApproval: true,
        },
      ],
      assumptions: [
        `About ${minutesEach} minutes of staff time per junk enquiry.`,
        'Spend on spam is estimated as its share of enquiries times the ad group’s spend.',
      ],
    })
  }

  // ── 4. Out of area, paid only.
  const outByAg = new Map<string, ClassifiedLead[]>()
  for (const c of d.classified) {
    if (c.category !== 'out_of_area' || c.lead.source !== 'ppc' || !c.lead.adGroupId) continue
    outByAg.set(c.lead.adGroupId, [...(outByAg.get(c.lead.adGroupId) ?? []), c])
  }
  for (const [ag, list] of outByAg) {
    const u = d.units.find((x) => x.key === `ag:${ag}`)
    if (!u || list.length < 4 || list.length / u.enquiries < 0.08) continue
    const places = countBy(list.map((c) => c.lead.location!.country))
    const campaign = input.adGroups.find((g) => g.adGroupId === ag)?.campaignId
    recs.push({
      id: `ld-area-${stableId(ag)}`,
      engine: 'leads',
      title: `${u.label}: ${pct(list.length / u.enquiries)} of paid enquiries are from places you cannot serve`,
      summary: `${list.length} enquiries came from ${[...places.keys()].join(', ')}, outside ${profile.serviceAreas.join(', ')}. Google’s location targeting is best-effort and, by default, also shows ads to people merely interested in a place. Target people who are in your areas, and exclude these countries.`,
      monthlyImpact: monthly((u.cost * list.length) / u.enquiries, d.days),
      confidence: 'measured',
      evidence: [
        ...[...places.entries()].map(([p, n]) => ({ label: `From ${p}`, value: `${n} enquiries` })),
        { label: 'Your service areas', value: profile.serviceAreas.join(', ') },
      ],
      actions: [
        {
          kind: 'add_location_exclusions',
          description: `Set the campaign to “Presence: people in your targeted locations” and exclude ${[...places.keys()].join(', ')}`,
          payload: { campaignId: campaign, locationOption: 'PRESENCE', exclude: [...places.keys()] },
          undo: { campaignId: campaign, locationOption: 'PRESENCE_OR_INTEREST', exclude: [] },
          requiresApproval: true,
        },
      ],
      assumptions: ['Spend is estimated as the share of enquiries times the ad group’s spend.'],
    })
  }

  // ── 5. Feed real outcomes back to Google.
  if (d.paidEnquiries > 0) {
    const qualified = d.offlineRows.filter((r) => r.conversionName === 'Qualified enquiry').length
    const customers = d.offlineRows.filter((r) => r.conversionName === 'Customer').length
    recs.push({
      id: 'ld-offline',
      engine: 'leads',
      title: `Google thinks you got ${d.paidEnquiries} good enquiries; ${d.paidEnquiries - d.paidNotProspects} were real prospects`,
      summary: `Google Ads counts every form sent as the same conversion, so its bidding is learning from ${d.paidNotProspects} enquiries that were spam, wrong service or out of area. Upload what actually happened: ${qualified} qualified enquiries and ${customers} customers, by click id. Unreachable and open enquiries are left out, because unknown is not the same as bad.`,
      monthlyImpact: 0,
      confidence: 'measured',
      evidence: [
        { label: 'Paid enquiries counted by Google', value: String(d.paidEnquiries) },
        {
          label: 'Not real prospects',
          value: `${d.paidNotProspects} (${pct(d.paidNotProspects / d.paidEnquiries)})`,
        },
        { label: 'Qualified enquiries to upload', value: String(qualified) },
        { label: 'Customers to upload', value: String(customers) },
      ],
      actions: [
        {
          kind: 'upload_offline_conversions',
          description: `Upload ${d.offlineRows.length} verified outcomes to Google Ads as “Qualified enquiry” and “Customer” conversions`,
          payload: { rows: d.offlineRows.length, conversionActions: ['Qualified enquiry', 'Customer'] },
          undo: {
            kind: 'retract_conversions',
            note: 'Google supports retracting uploaded conversions by click id',
          },
          requiresApproval: true,
        },
      ],
      assumptions: [
        'Needs two conversion actions in Google Ads (“Qualified enquiry”, “Customer”) set to import from clicks.',
        'Click ids older than 90 days are rejected by Google and will be skipped.',
      ],
    })
  }

  return recs
}

function inferServiceFromAg(profile: BusinessProfile, ag: string): string | null {
  return profile.services.find((s) => s.adGroupIds.includes(ag))?.id ?? null
}

export function countBy<T>(xs: T[]): Map<T, number> {
  const m = new Map<T, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

function mostCommon(xs: string[]): string | null {
  const m = countBy(xs)
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}
