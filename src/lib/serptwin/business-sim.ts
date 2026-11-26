import type {
  BusinessProfile,
  PageMeta,
  KeywordRow,
  Lead,
  LeadOutcome,
  OrganicRow,
  SearchTermRow,
  SerpTwinInput,
} from './types'
import { binomial, gaussian, poisson, rng, type Rng } from './stats'
import { shiftDate } from './engines/drift'

/**
 * The simulated business behind the simulated ads: three services with
 * different margins and capacity, two new campaigns, and eight weeks of
 * enquiries with outcomes.
 *
 * As with the ad simulator, the point is planted truth the tests can check
 * the engines recover:
 *   – "email marketing services" draws people wanting email lists (wrong service)
 *   – the broad AI ad group draws bots and overseas enquiries
 *   – enquiries on Friday evenings and weekends wait, and mostly die
 *   – some suitable people are simply never reachable — not bad leads
 *   – implementation is booked out; managed campaigns has room and earns most
 *   – platform sales are lost over "what does the price include"
 *
 * It draws from its own random stream, so adding it changed nothing in the
 * ad data the other engines were already tested against.
 */

export const BUSINESS_TRUTH = {
  wrongServiceAdGroup: 'ag_managed',
  spamAdGroup: 'ag_ai',
  missedWinRateFactor: 0.15,
  fullyBookedService: 'implementation',
  growService: 'managed',
  pricingTopicService: 'platform',
} as const

const SITE = 'https://www.cygroup.example'
const DAYS = 56
const END = '2026-09-27'

export const DEFAULT_BUSINESS: BusinessProfile = {
  services: [
    {
      id: 'platform',
      name: 'Platform subscription',
      keywords: ['software', 'platform', 'tool', 'tools', 'pricing', 'trial', 'subscription', 'plan'],
      // Brand is left out on purpose: you cannot buy more searches for your own name.
      adGroupIds: ['ag_ma', 'ag_compare', 'ag_email', 'ag_ai'],
      marginPerCustomer: 1400,
      weeklyCapacity: null,
      bookedThisWeek: 0,
      landingPages: [`${SITE}/pricing`],
      growthPriority: 'maintain',
    },
    {
      id: 'implementation',
      name: 'Implementation & migration',
      keywords: ['migration', 'migrate', 'implementation', 'onboarding', 'setup', 'switch'],
      adGroupIds: ['ag_impl'],
      marginPerCustomer: 2600,
      weeklyCapacity: 4,
      bookedThisWeek: 4,
      landingPages: [`${SITE}/migration`],
      growthPriority: 'maintain',
    },
    {
      id: 'managed',
      name: 'Managed campaigns',
      keywords: ['agency', 'managed', 'done for you', 'services', 'campaign management'],
      adGroupIds: ['ag_managed'],
      marginPerCustomer: 4200,
      weeklyCapacity: 3,
      bookedThisWeek: 1,
      landingPages: [`${SITE}/managed-campaigns`],
      growthPriority: 'grow',
    },
  ],
  serviceAreas: ['GB', 'IE'],
  notOffered: [
    'email list',
    'email database',
    'b2b database',
    'buy data',
    'website design',
    'web design',
    'seo agency',
  ],
  followUpSlaHours: 4,
  unreachableAfterAttempts: 3,
  maxWeeklyBudgetChange: 0.2,
}

export interface Term {
  term: string
  kw: string
  ag: string
  c: string
  imp: number
  ctr: number
  cpc: number
  cvr: number
  /** Share of this term's enquiries that want something the business does not sell. */
  wrong: number
  org?: { pos: number; imp: number; page: string }
}

const NEW_KEYWORDS: KeywordRow[] = [
  {
    keywordId: 'k13',
    adGroupId: 'ag_managed',
    campaignId: 'c_managed',
    text: 'marketing automation agency',
    matchType: 'PHRASE',
  },
  {
    keywordId: 'k15',
    adGroupId: 'ag_managed',
    campaignId: 'c_managed',
    text: 'email marketing services',
    matchType: 'BROAD',
  },
  {
    keywordId: 'k14',
    adGroupId: 'ag_impl',
    campaignId: 'c_impl',
    text: 'marketing automation implementation',
    matchType: 'PHRASE',
  },
]

const NEW_TERMS: Term[] = [
  {
    term: 'marketing automation agency uk',
    kw: 'k13',
    ag: 'ag_managed',
    c: 'c_managed',
    imp: 60,
    ctr: 0.06,
    cpc: 7.5,
    cvr: 0.07,
    wrong: 0.03,
  },
  {
    term: 'managed marketing automation',
    kw: 'k13',
    ag: 'ag_managed',
    c: 'c_managed',
    imp: 30,
    ctr: 0.05,
    cpc: 8,
    cvr: 0.06,
    wrong: 0.03,
  },
  {
    term: 'email marketing services',
    kw: 'k15',
    ag: 'ag_managed',
    c: 'c_managed',
    imp: 80,
    ctr: 0.05,
    cpc: 5,
    cvr: 0.05,
    wrong: 0.25,
  },
  {
    term: 'buy email list uk',
    kw: 'k15',
    ag: 'ag_managed',
    c: 'c_managed',
    imp: 40,
    ctr: 0.06,
    cpc: 3.5,
    cvr: 0.12,
    wrong: 0.95,
  },
  {
    term: 'b2b email database',
    kw: 'k15',
    ag: 'ag_managed',
    c: 'c_managed',
    imp: 25,
    ctr: 0.05,
    cpc: 3.8,
    cvr: 0.1,
    wrong: 0.95,
  },
  {
    term: 'email marketing services for small business',
    kw: 'k15',
    ag: 'ag_managed',
    c: 'c_managed',
    imp: 30,
    ctr: 0.05,
    cpc: 5,
    cvr: 0.05,
    wrong: 0.1,
  },
  {
    term: 'marketing automation implementation',
    kw: 'k14',
    ag: 'ag_impl',
    c: 'c_impl',
    imp: 35,
    ctr: 0.05,
    cpc: 6,
    cvr: 0.07,
    wrong: 0.02,
  },
  {
    term: 'pipeloop migration',
    kw: 'k14',
    ag: 'ag_impl',
    c: 'c_impl',
    imp: 20,
    ctr: 0.07,
    cpc: 5,
    cvr: 0.09,
    wrong: 0.02,
    org: { pos: 4.2, imp: 60, page: `${SITE}/migration` },
  },
  {
    term: 'crm migration services',
    kw: 'k14',
    ag: 'ag_impl',
    c: 'c_impl',
    imp: 25,
    ctr: 0.05,
    cpc: 6.5,
    cvr: 0.06,
    wrong: 0.05,
  },
]

const MESSAGES: Record<string, string[]> = {
  platform: [
    'Does the £49 plan include onboarding? What does the price include exactly?',
    'Hi, what does the price include? Are there any setup fees on top?',
    'We are a team of 6. How much would it cost for us, and is VAT included?',
    'Can we migrate our lists from Pipeloop? How long does that take?',
    'Looking at options for next quarter. Do you have case studies from B2B SaaS?',
    'How does the approval workflow work for a team of 10?',
  ],
  implementation: [
    'How long does a migration from Pipeloop take? We need to switch before our renewal.',
    'Can you start this month? Our contract ends in 5 weeks.',
    'What does the implementation process involve and what do we need to provide?',
    'Do you migrate historic campaign data as well as contacts?',
  ],
  managed: [
    'Do you work with UK charities? We have a small team and need help running campaigns.',
    'What results have similar B2B clients seen? Do you have examples?',
    'How does the managed service work, step by step?',
    'Could you run our email and LinkedIn campaigns each month? What would it cost?',
  ],
  wrong: [
    'Looking to buy an email list of UK marketing managers, 5,000 contacts. Price?',
    'Do you sell a B2B email database for the construction sector?',
    'We need a website design refresh, can you quote?',
    'Can you provide an email list of HR directors in the North West?',
  ],
  spam: [
    'Best SEO services cheap!!! visit http://rank-fast.example and www.cheap-links.example',
    'Guest post offer http://links.example/deal http://links.example/pay',
    'asdkjh qwe zxc',
  ],
}

const LOST: Record<string, [string, number][]> = {
  platform: [
    ['Wasn’t clear what the price includes', 0.28],
    ['Onboarding fee on top put them off — too expensive', 0.2],
    ['Not now, looking again next quarter', 0.18],
    ['Went with Pipeloop', 0.2],
    ['Missing a Salesforce integration they need', 0.14],
  ],
  implementation: [
    ['Wanted to start this month; we are booked 3 weeks out', 0.5],
    ['Quote too high for the migration', 0.2],
    ['Went with another provider who could start sooner', 0.3],
  ],
  managed: [
    ['Not now, budget freed up next year', 0.35],
    ['Went with a local agency', 0.35],
    ['Price higher than expected', 0.3],
  ],
}

const CLOSE: Record<string, number> = { platform: 0.24, implementation: 0.3, managed: 0.38 }
const UK_AREAS = ['M', 'SK', 'LS', 'B', 'EC', 'N', 'SW', 'BS', 'G', 'EH', 'CF', 'NE']

function pick<T>(r: Rng, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!
}
function weighted(r: Rng, xs: [string, number][]): string {
  let u = r()
  for (const [x, w] of xs) {
    u -= w
    if (u <= 0) return x
  }
  return xs[xs.length - 1]![0]
}

/**
 * Everything that makes one simulated business different from another. The
 * engines see only the leads and the profile drawn from it.
 */
export interface BusinessPreset {
  id: string
  business: BusinessProfile
  newKeywords: KeywordRow[]
  newAdGroups: { adGroupId: string; campaignId: string; name: string }[]
  newTerms: Term[]
  extraPages: PageMeta[]
  messages: Record<string, string[]>
  lost: Record<string, [string, number][]>
  close: Record<string, number>
  localAreas: string[]
  brandAdGroup: string | null
  spamAdGroup: string
  /** Chance a paid enquiry from this ad group comes from outside the service area. */
  areaRisk: Record<string, number>
  /** Services picked for organic and brand enquiries, weighted by repetition. */
  organicServiceMix: string[]
  defaultLanding: string
  /** Share of each search's enquiries wanting something the business does not offer. */
  wrongShare: Record<string, number>
  /** Wrong-service messages matched to the words in the search, first match wins. */
  wrongMessageHints?: [string, RegExp][]
}

function isoAt(date: string, hour: number): string {
  // Britain is on BST for the whole simulated window (August–September), UTC+1.
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCMinutes(Math.round((hour - 1) * 60))
  return d.toISOString()
}

export function addBusiness(input: SerpTwinInput, seed: number, preset: BusinessPreset = CY_BUSINESS): SerpTwinInput {
  const r = rng(seed ^ 0x5eed)
  const B = preset.business
  const serviceOfAg = (ag: string) => B.services.find((s) => s.adGroupIds.includes(ag))?.id ?? B.services[0]!.id
  const dates = Array.from({ length: DAYS }, (_, i) => shiftDate(END, -(DAYS - 1 - i)))

  const searchTerms: SearchTermRow[] = []
  const organic: OrganicRow[] = []
  for (const date of dates) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const s = dow === 0 || dow === 6 ? 0.6 : 1
    for (const t of preset.newTerms) {
      const imp = poisson(t.imp * s * (1 + 0.08 * gaussian(r)), r)
      if (imp <= 0) continue
      const clicks = binomial(imp, t.ctr, r)
      const conv = binomial(clicks, t.cvr, r)
      searchTerms.push({
        date,
        campaignId: t.c,
        adGroupId: t.ag,
        keywordId: t.kw,
        searchTerm: t.term,
        impressions: imp,
        clicks,
        costMicros: Math.round(clicks * t.cpc * Math.max(0.6, 1 + 0.12 * gaussian(r)) * 1e6),
        conversions: conv,
        conversionValue: 0,
      })
      if (t.org) {
        const oi = poisson(t.org.imp * s, r)
        organic.push({
          date,
          query: t.term,
          page: t.org.page,
          impressions: oi,
          clicks: binomial(oi, 0.07, r),
          position: t.org.pos,
        })
      }
    }
  }

  const allTerms = [...input.searchTerms, ...searchTerms]
  const leads: Lead[] = []
  let n = 0
  const termWrong = new Map([...preset.newTerms.map((t) => [t.term, t.wrong] as const), ...Object.entries(preset.wrongShare)])

  const makeLead = (
    date: string,
    source: Lead['source'],
    row: { campaignId?: string; adGroupId?: string; searchTerm?: string } | null,
    landingPage: string,
  ) => {
    let landing = landingPage
    const id = `L${String(++n).padStart(4, '0')}`
    const ag = row?.adGroupId ?? null
    const svc =
      ag && ag !== preset.brandAdGroup ? serviceOfAg(ag) : pick(r, preset.organicServiceMix)
    if (!ag || ag === preset.brandAdGroup)
      landing = B.services.find((x) => x.id === svc)!.landingPages[0] ?? preset.defaultLanding
    const spamP = ag === preset.spamAdGroup ? 0.2 : 0.05
    const areaP = ag ? (preset.areaRisk[ag] ?? 0.03) : 0.03
    const wrongP = row?.searchTerm ? (termWrong.get(row.searchTerm) ?? 0.03) : 0.02
    const u = r()
    const kind =
      u < spamP ? 'spam' : u < spamP + wrongP * (1 - spamP) ? 'wrong' : r() < areaP ? 'abroad' : 'real'

    // Bots arrive at night; people mostly in working hours, with a real evening/weekend tail.
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const hour =
      kind === 'spam' ? 1 + r() * 5 : r() < 0.72 ? 9 + r() * 8 : r() < 0.5 ? 17.5 + r() * 4.5 : 7 + r() * 2
    const receivedAt = isoAt(date, hour)
    const afterHours = dow === 0 || dow === 6 || (dow === 5 && hour >= 16) || hour >= 17.5

    const lead: Lead = {
      id,
      receivedAt,
      source,
      gclid: source === 'ppc' ? `sim-${id.toLowerCase()}-${Math.floor(r() * 1e9).toString(36)}` : null,
      campaignId: row?.campaignId ?? null,
      adGroupId: ag,
      searchTerm: row?.searchTerm ?? null,
      landingPage: landing,
      serviceId: null,
      message: '',
      email: `person${n}@example.co.uk`,
      phone: `07700 9${String(n).padStart(5, '0')}`,
      location: { country: 'GB', area: pick(r, preset.localAreas) },
      signals: {
        secondsToSubmit: 25 + Math.floor(r() * 200),
        honeypotFilled: false,
        disposableEmail: false,
        phoneValid: true,
      },
      firstResponseAt: null,
      contactAttempts: 0,
      outcome: 'open',
      lostReason: null,
      value: null,
    }

    if (kind === 'spam') {
      lead.message = pick(r, preset.messages.spam!)
      lead.signals = {
        secondsToSubmit: 1 + Math.floor(r() * 2),
        honeypotFilled: r() < 0.5,
        disposableEmail: r() < 0.6,
        phoneValid: r() < 0.3,
      }
      lead.email = `x${n}@mailinator.example`
      lead.location = { country: pick(r, ['US', 'IN', 'RU']), area: null }
      lead.contactAttempts = 1
      lead.firstResponseAt = isoAt(date, 11)
      lead.outcome = r() < 0.5 ? 'spam' : 'open'
      return lead
    }
    if (kind === 'wrong') {
      const term = row?.searchTerm ?? ''
      const hint = preset.wrongMessageHints?.find(([, re]) => re.test(term))
      const fits = preset.messages.wrong!.filter((m) => (hint ? m.toLowerCase().includes(hint[0]) : true))
      lead.message = pick(r, fits.length ? fits : preset.messages.wrong!)
      lead.contactAttempts = 1
      lead.firstResponseAt = isoAt(shiftDate(date, 1), 10)
      lead.outcome = r() < 0.6 ? 'unqualified' : 'lost'
      lead.lostReason = r() < 0.5 ? 'Wanted an email list — not what we do' : 'Not what we do'
      return lead
    }
    lead.message = pick(r, preset.messages[svc]!)
    if (kind === 'abroad') lead.location = { country: pick(r, ['US', 'IN', 'AE']), area: null }

    // Follow-up. Out-of-hours enquiries often wait until the next working day, and many are lost in that wait.
    const missed = afterHours ? r() < 0.3 : r() < 0.05
    const unreachable = r() < 0.1
    if (missed) {
      if (r() < 0.5) {
        lead.firstResponseAt = null
        lead.contactAttempts = 0
      } else {
        lead.firstResponseAt = isoAt(shiftDate(date, dow === 5 ? 4 : 2), 15)
        lead.contactAttempts = 1
      }
    } else {
      lead.firstResponseAt = new Date(
        new Date(receivedAt).getTime() + (0.3 + r() * 1.5) * 3_600_000,
      ).toISOString()
      lead.contactAttempts = 1 + Math.floor(r() * 2)
    }
    if (kind === 'abroad') {
      lead.outcome = r() < 0.5 ? 'unqualified' : 'lost'
      lead.lostReason = 'Based overseas'
      return lead
    }
    if (unreachable && !missed) {
      lead.contactAttempts = 3 + Math.floor(r() * 2)
      lead.outcome = r() < 0.5 ? 'lost' : 'open'
      lead.lostReason = lead.outcome === 'lost' ? 'No answer after 3 calls and 2 emails' : null
      return lead
    }
    const p = preset.close[svc]! * (missed ? BUSINESS_TRUTH.missedWinRateFactor : 1)
    if (r() < p) {
      lead.outcome = 'won'
      lead.value = B.services.find((s) => s.id === svc)!.marginPerCustomer
    } else if (r() < 0.12) {
      lead.outcome = 'open'
    } else {
      lead.outcome = 'lost' as LeadOutcome
      lead.lostReason = missed
        ? pick(r, ['Went with someone who replied first', 'Never got back to us', 'Chose another provider'])
        : weighted(r, preset.lost[svc]!)
    }
    return lead
  }

  const landingFor = (ag: string) =>
    B.services.find((s) => s.adGroupIds.includes(ag))?.landingPages[0] ?? preset.defaultLanding

  // Every conversion Google counted is one enquiry.
  for (const row of allTerms) {
    for (let i = 0; i < row.conversions; i++)
      leads.push(makeLead(row.date, 'ppc', row, landingFor(row.adGroupId)))
  }
  // Organic enquiries: a small share of organic clicks on commercial pages.
  const orgByDate = new Map<string, number>()
  for (const o of input.organic)
    if (!o.page.includes('/blog/') && !o.page.endsWith('/login'))
      orgByDate.set(o.date, (orgByDate.get(o.date) ?? 0) + o.clicks)
  for (const [date, clicks] of orgByDate) {
    const k = binomial(clicks, 0.006, r)
    for (let i = 0; i < k; i++) leads.push(makeLead(date, 'organic', null, preset.defaultLanding))
  }

  // Bots hit the form directly, mostly overnight. Google never sees these; your team does.
  for (const date of dates) {
    const k = poisson(1.1, r)
    for (let i = 0; i < k; i++) {
      const l = makeLead(date, 'direct', null, preset.defaultLanding)
      l.message = pick(r, preset.messages.spam!)
      l.signals = {
        secondsToSubmit: 1 + Math.floor(r() * 2),
        honeypotFilled: r() < 0.5,
        disposableEmail: r() < 0.7,
        phoneValid: r() < 0.3,
      }
      l.receivedAt = isoAt(date, 1 + r() * 5)
      l.location = { country: pick(r, ['US', 'RU', 'VN']), area: null }
      l.outcome = 'open'
      l.lostReason = null
      leads.push(l)
    }
  }

  const pages = [...input.pages, ...preset.extraPages]

  return {
    ...input,
    keywords: [...input.keywords, ...preset.newKeywords],
    adGroups: [...input.adGroups, ...preset.newAdGroups],
    searchTerms: allTerms,
    organic: [...input.organic, ...organic],
    pages,
    business: structuredClone(B),
    leads,
  }
}

export const CY_BUSINESS: BusinessPreset = {
  id: 'cy-group',
  business: DEFAULT_BUSINESS,
  newKeywords: NEW_KEYWORDS,
  newAdGroups: [
    { adGroupId: 'ag_managed', campaignId: 'c_managed', name: 'Managed campaigns' },
    { adGroupId: 'ag_impl', campaignId: 'c_impl', name: 'Implementation' },
  ],
  newTerms: NEW_TERMS,
  extraPages: [
    {
      url: `${SITE}/migration`,
      title: 'Migration Services | CY Group',
      metaDescription: 'Move from your current platform to CY Group with our implementation team.',
    },
    {
      url: `${SITE}/managed-campaigns`,
      title: 'Managed Campaigns | CY Group',
      metaDescription: 'Our team plans and runs your email and LinkedIn campaigns every month.',
    },
  ],
  messages: MESSAGES,
  lost: LOST,
  close: CLOSE,
  localAreas: UK_AREAS,
  brandAdGroup: 'ag_brand',
  spamAdGroup: 'ag_ai',
  areaRisk: { ag_ai: 0.2, ag_ma: 0.12 },
  organicServiceMix: ['platform', 'platform', 'implementation', 'managed'],
  defaultLanding: `${SITE}/pricing`,
  wrongShare: {},
  wrongMessageHints: [
    ['list', /list/],
    ['database', /database/],
  ],
}
