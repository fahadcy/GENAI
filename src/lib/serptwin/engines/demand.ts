import type { BusinessProfile, Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import type { ClassifiedLead, LeadDiagnosis } from './leads'
import { NOT_A_PROSPECT } from './leads'
import { formatMoney, queryKey, stableId } from '../normalise'
import { monthly } from '../ledger'

/**
 * ENGINE 7 — SEO work chosen by real customer demand.
 *
 * An SEO audit lists fifty issues. It cannot say which one stands between
 * this business and its next customer, because it has never seen a customer.
 * This engine has: it reads the questions people actually ask in enquiries,
 * the reasons sales were lost, the searches that bring paid and organic
 * traffic, and which services the business wants to grow. From those it picks
 * the three pieces of work most likely to bring suitable customers, each with
 * its evidence and an editable draft.
 *
 * It does not promise rankings. A better pricing page may not move a single
 * position. What it can do is answer the question that is losing sales, for
 * visitors from paid and organic alike, and measure qualified enquiries to
 * that page before and after.
 */

export type Topic = 'pricing' | 'timeline' | 'process' | 'eligibility' | 'comparison' | 'trust' | 'coverage'

export const TOPIC_LABEL: Record<Topic, string> = {
  pricing: 'What it costs and what is included',
  timeline: 'How long it takes and when you can start',
  process: 'How it works, step by step',
  eligibility: 'Who it is for and whether they qualify',
  comparison: 'How you compare, and switching from someone else',
  trust: 'Proof you can be trusted',
  coverage: 'Where you work',
}

const TOPIC_WORDS: Record<Topic, RegExp> = {
  pricing:
    /\b(price|prices|pricing|cost|costs|fee|fees|quote|include|included|includes|charge|how much|expensive|hidden|vat|£)/i,
  timeline:
    /\b(how long|when can|start|timescale|timeline|turnaround|weeks?|days?|quick|soon|this month|lead time)\b/i,
  process: /\b(how does|how do|what happens|steps?|process|involve|what do (i|we) need)\b/i,
  eligibility:
    /\b(can (i|we|you)|do you (do|work|offer|cover|support)|suitable|qualify|eligible|small (business|team)|charit(y|ies))\b/i,
  comparison:
    /\b(vs|versus|compare|switch|switching|migrate|move from|alternative|better than|instead of|went with|chose|another provider)\b/i,
  trust:
    /\b(reviews?|regulated|accredited|insured|case stud(y|ies)|results|examples? of|references?|track record)\b/i,
  coverage: /\b(area|near|cover|based in|local|location|travel|come to)\b/i,
}

/** Which topic a lost-sale category points at. */
const LOST_TOPIC: Partial<Record<ClassifiedLead['category'], Topic>> = {
  lost_price: 'pricing',
  lost_timing: 'timeline',
  lost_competitor: 'comparison',
  lost_fit: 'eligibility',
}

const GROWTH_WEIGHT = { grow: 1.5, maintain: 1, reduce: 0.3 } as const

/** Share of topic-related lost sales assumed recoverable by answering the question well. A stated guess. */
export const RECOVERY_ASSUMPTION = 0.1

export interface DemandAction {
  id: string
  serviceId: string
  serviceName: string
  topic: Topic
  score: number
  askedInEnquiries: number
  lostOverIt: number
  searchImpressions: number
  quotes: string[]
  searches: string[]
  page: string | null
  pageAlreadyCovers: boolean
  monthlyAtStake: number
  draft: { title: string; outline: string[] }
}

export function findTopics(text: string): Topic[] {
  return (Object.keys(TOPIC_WORDS) as Topic[]).filter((t) => TOPIC_WORDS[t].test(text))
}

/** Question-like sentences, with contact details stripped so a draft never quotes a person. */
export function questionsIn(message: string): string[] {
  return message
    .replace(/\S+@\S+/g, '[email]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[phone]')
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith('?') || /^(how|what|when|can|do|does|is|are|will|which)\b/i.test(s))
}

export function prioritiseSeo(input: SerpTwinInput, d: LeadDiagnosis, days: number): DemandAction[] {
  const profile = input.business!
  const pages = new Map(input.pages.map((p) => [p.url, p]))
  const serviceFor = (text: string) =>
    profile.services.find((s) => s.keywords.some((k) => queryKey(text).includes(queryKey(k))))?.id ?? null

  // Search demand per service and topic: organic impressions plus paid impressions.
  const searchDemand = new Map<string, { impressions: number; examples: Map<string, number> }>()
  const addSearch = (q: string, impressions: number, serviceHint: string | null) => {
    const sid = serviceFor(q) ?? serviceHint
    if (!sid) return
    for (const t of findTopics(q)) {
      const k = `${sid}|${t}`
      const e = searchDemand.get(k) ?? { impressions: 0, examples: new Map() }
      e.impressions += impressions
      e.examples.set(q, (e.examples.get(q) ?? 0) + impressions)
      searchDemand.set(k, e)
    }
  }
  for (const r of input.organic) addSearch(r.query, r.impressions, null)
  for (const r of input.searchTerms)
    addSearch(
      r.searchTerm,
      r.impressions,
      profile.services.find((s) => s.adGroupIds.includes(r.adGroupId))?.id ?? null,
    )

  const prospects = d.classified.filter((c) => !NOT_A_PROSPECT.has(c.category) && c.serviceId)
  const cells = new Map<string, { asked: ClassifiedLead[]; lost: ClassifiedLead[]; quotes: string[] }>()
  const cell = (sid: string, t: Topic) => {
    const k = `${sid}|${t}`
    const c = cells.get(k) ?? { asked: [], lost: [], quotes: [] }
    cells.set(k, c)
    return c
  }
  for (const c of prospects) {
    const qs = questionsIn(c.lead.message)
    const topics = new Set(qs.flatMap(findTopics))
    for (const t of topics) {
      const x = cell(c.serviceId!, t)
      x.asked.push(c)
      const q = qs.find((s) => TOPIC_WORDS[t].test(s))
      if (q && x.quotes.length < 4 && !x.quotes.includes(q)) x.quotes.push(q)
    }
    // A lost sale counts toward a topic only when the reason itself is about that topic:
    // "not now, next quarter" is lost on timing, but no page would have changed it.
    const lostTopic = LOST_TOPIC[c.category]
    if (lostTopic && c.lead.lostReason && TOPIC_WORDS[lostTopic].test(c.lead.lostReason)) {
      const x = cell(c.serviceId!, lostTopic)
      x.lost.push(c)
      const q = `Lost: “${c.lead.lostReason}”`
      if (x.quotes.length < 4 && !x.quotes.includes(q)) x.quotes.push(q)
    }
  }

  const actions: DemandAction[] = []
  for (const [k, v] of cells) {
    const [sid, topic] = k.split('|') as [string, Topic]
    const s = profile.services.find((x) => x.id === sid)!
    if (v.asked.length + v.lost.length < 5) continue
    const sd = searchDemand.get(k)
    const page = s.landingPages[0] ?? null
    const meta = page ? pages.get(page) : undefined
    const covers = meta ? TOPIC_WORDS[topic].test(`${meta.title} ${meta.metaDescription}`) : false
    const atStake = monthly(v.lost.length * s.marginPerCustomer, days)
    const marginWeight = s.marginPerCustomer / Math.max(1, avgMargin(profile))
    const score =
      (v.asked.length + 3 * v.lost.length + (sd ? Math.log10(1 + sd.impressions) : 0)) *
      marginWeight *
      GROWTH_WEIGHT[s.growthPriority] *
      (covers ? 0.6 : 1)
    actions.push({
      id: `dm-${stableId(sid, topic)}`,
      serviceId: sid,
      serviceName: s.name,
      topic,
      score,
      askedInEnquiries: v.asked.length,
      lostOverIt: v.lost.length,
      searchImpressions: Math.round(sd?.impressions ?? 0),
      quotes: v.quotes,
      searches: [...(sd?.examples.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([q]) => q),
      page,
      pageAlreadyCovers: covers,
      monthlyAtStake: atStake,
      draft: draftFor(s.name, topic, v.quotes, profile),
    })
  }
  actions.sort((a, b) => b.score - a.score)
  // No more than two of the week's three for one service, so one busy service cannot crowd out the rest.
  const top: DemandAction[] = []
  const rest: DemandAction[] = []
  for (const a of actions) {
    if (top.length < 3 && top.filter((t) => t.serviceId === a.serviceId).length < 2) top.push(a)
    else rest.push(a)
  }
  return [...top, ...rest]
}

function avgMargin(p: BusinessProfile): number {
  return p.services.reduce((s, x) => s + x.marginPerCustomer, 0) / Math.max(1, p.services.length)
}

/**
 * An editable outline, not finished copy. Facts the engine does not know are
 * left as marked gaps for a person to fill, because a page that guesses at
 * what a price includes does more harm than no page.
 */
function draftFor(
  service: string,
  topic: Topic,
  quotes: string[],
  profile: BusinessProfile,
): DemandAction['draft'] {
  const q = quotes.filter((x) => !x.startsWith('Lost:')).slice(0, 3)
  const faq = q.map((x) => `FAQ — “${x}” → [answer in one or two sentences]`)
  const by: Record<Topic, { title: string; outline: string[] }> = {
    pricing: {
      title: `${service}: what it costs and what is included`,
      outline: [
        'Price up front, in pounds, with VAT stated: [price] (+VAT / inc. VAT)',
        'What is included: [list every stage the fee covers]',
        'What is not included, and what it costs if needed: [exclusions]',
        'When you pay: [payment terms]',
        ...faq,
        'Link to this page from the service page and from the enquiry form',
      ],
    },
    timeline: {
      title: `${service}: how long it takes and when we can start`,
      outline: [
        'Typical timeline, stage by stage: [stages and durations]',
        'Earliest start date right now: [date] — keep this current',
        'What speeds it up or slows it down: [factors]',
        ...faq,
      ],
    },
    process: {
      title: `How ${service.toLowerCase()} works, step by step`,
      outline: [
        'Step 1–4 with what the customer does and what you do: [steps]',
        'What you need from the customer: [documents / access]',
        ...faq,
      ],
    },
    eligibility: {
      title: `Is ${service.toLowerCase()} right for you?`,
      outline: [
        'Who it is for: [types of customer]',
        'Who it is not for, and where to go instead: [honest exclusions]',
        ...(profile.notOffered.length
          ? [`We do not offer: ${profile.notOffered.slice(0, 4).join(', ')}`]
          : []),
        ...faq,
      ],
    },
    comparison: {
      title: `Switching to us for ${service.toLowerCase()}`,
      outline: [
        'What changes and what stays the same: [facts only, no competitor claims you cannot prove]',
        'How switching works and how long it takes: [steps]',
        ...faq,
      ],
    },
    trust: {
      title: `${service}: results and who we have worked with`,
      outline: [
        'Two or three short case studies with numbers the client has approved: [cases]',
        'Accreditations and memberships: [list, with numbers]',
        ...faq,
      ],
    },
    coverage: {
      title: `Where we provide ${service.toLowerCase()}`,
      outline: [
        `Areas served: ${profile.serviceAreas.join(', ') || '[areas]'}`,
        'Keep it to one accurate page. Google ranks local results on distance, relevance and prominence; a page per town does not change distance.',
        ...faq,
      ],
    },
  }
  return by[topic]
}

export function demandRecommendations(actions: DemandAction[], settings: SerpTwinSettings): Recommendation[] {
  const money = (n: number) => formatMoney(n, settings.currency)
  return actions.slice(0, 3).map((a, i) => ({
    id: a.id,
    engine: 'demand' as const,
    title: `SEO this week: ${TOPIC_LABEL[a.topic].toLowerCase()} — ${a.serviceName}`,
    summary: `${a.askedInEnquiries} enquiries for ${a.serviceName} asked about this${
      a.lostOverIt ? `, and ${a.lostOverIt} sales were lost over it` : ''
    }.${a.searchImpressions ? ` Searches on the topic had ${a.searchImpressions.toLocaleString('en-GB')} impressions.` : ''} ${
      a.page
        ? a.pageAlreadyCovers
          ? `${pathOf(a.page)} touches on it but does not answer it.`
          : `${pathOf(a.page)} does not answer it.`
        : 'No page answers it.'
    } Answer it on the page, for visitors from paid and organic search alike.`,
    monthlyImpact: a.monthlyAtStake * RECOVERY_ASSUMPTION,
    confidence: 'hypothesis' as const,
    evidence: [
      { label: 'Priority this week', value: `${i + 1} of ${Math.min(3, actions.length)}` },
      { label: 'Asked in enquiries', value: String(a.askedInEnquiries) },
      { label: 'Sales lost over it', value: String(a.lostOverIt) },
      ...a.quotes
        .slice(0, 3)
        .map((q, j) => ({
          label: j === 0 ? 'In their words' : ' ',
          value: q.startsWith('Lost:') ? q : `“${q}”`,
        })),
      ...(a.searches.length
        ? [{ label: 'Related searches', value: a.searches.map((s) => `“${s}”`).join(', ') }]
        : []),
      { label: 'Profit in those lost sales', value: `${money(a.monthlyAtStake)}/mo` },
    ],
    actions: [
      {
        kind: 'create_content_brief' as const,
        description: `Draft “${a.draft.title}” in Content Studio from the outline, then publish through approval`,
        payload: {
          targetQuery: a.draft.title,
          supporting: a.draft.outline,
          intent: 'transactional',
          reason: 'demand',
          page: a.page,
        },
        undo: null,
        requiresApproval: false,
      },
    ],
    assumptions: [
      `Impact assumes 1 in ${Math.round(1 / RECOVERY_ASSUMPTION)} of the sales lost over this could be kept by answering it clearly. A guess, stated so it can be tested.`,
      'Measure qualified enquiries to the page for four weeks before and after. A later rise is not proof the change caused it.',
    ],
  }))
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
