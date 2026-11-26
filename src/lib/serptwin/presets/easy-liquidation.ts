import type { AdAccountPreset, TermSpec } from '../simulator'
import type { BusinessPreset } from '../business-sim'
import type { PageMeta } from '../types'

/**
 * Easy Liquidation — a UK company liquidation practice.
 *
 * REAL, from easyliquidation.co.uk as read on 29 September 2026:
 *   – the services (CVL; MVL mentioned but with no page of its own; help with
 *     bounce back loans and winding-up petitions via the FAQ)
 *   – the page URLs, their H1s, and their <title> and meta description, which
 *     are identical on every page read
 *   – the claims used in the ad copy: "from £1,499", "no hidden fees", "over
 *     30 years of experience", free confidential consultation, IPA and R3
 *     membership, five-star testimonials, phone 0333 052 2833
 *   – the questions customers ask, taken from the site's own FAQ
 *
 * SIMULATED: every number. Search volumes, clicks, costs, conversions,
 * rankings, auction overlap (competitors are fictional domains), ad
 * performance, enquiries and their outcomes, margins and capacity. The ad
 * copy is illustrative, built only from claims the site makes.
 */

const SITE = 'https://www.easyliquidation.co.uk'
const T = 'Easy Liquidation - Fast, Affordable & Confidential Company Liquidation'
const M =
  'Specialist company liquidator with over 30 years of experience. Hassle-free liquidation service starting from £1,499. Handle your company closure with professionalism.'

const PAGES: PageMeta[] = [
  { url: `${SITE}/`, title: T, metaDescription: M },
  { url: `${SITE}/company-liquidate`, title: T, metaDescription: M, h1: 'What happens once my company is in Liquidation?' },
  { url: `${SITE}/do-i-need-to-liquidate-my-company`, title: T, metaDescription: M, h1: 'Do I Need to Liquidate My Company?' },
  { url: `${SITE}/what-are-the-benefits-of-a-cvl`, title: T, metaDescription: M, h1: 'What are the Benefits of a CVL?' },
  { url: `${SITE}/calculator`, title: T, metaDescription: M},
  { url: `${SITE}/faq`, title: T, metaDescription: M},
  { url: `${SITE}/about-us`, title: T, metaDescription: M},
  { url: `${SITE}/contact`, title: T, metaDescription: M},
]

const TERMS: TermSpec[] = [
  // Brand
  { term: 'easy liquidation', kw: 'k1', imp: 25, ctr: 0.4, cpc: 1.2, cvr: 0.12, org: 1.0, page: '/', orgImp: 60 },
  { term: 'easyliquidation', kw: 'k2', imp: 6, ctr: 0.4, cpc: 1.0, cvr: 0.1, org: 1.0, page: '/', orgImp: 15 },
  // Company liquidation (CVL)
  { term: 'liquidate my company', kw: 'k3', imp: 90, ctr: 0.06, cpc: 14, cvr: 0.09, org: 6.5, page: '/company-liquidate', orgImp: 260 },
  { term: 'how to liquidate a company', kw: 'k3', imp: 70, ctr: 0.05, cpc: 11, cvr: 0.04, org: 9.2, page: '/do-i-need-to-liquidate-my-company', orgImp: 400 },
  { term: 'liquidate limited company uk', kw: 'k3', imp: 60, ctr: 0.06, cpc: 13, cvr: 0.08, org: 7.8, page: '/company-liquidate', orgImp: 200 },
  { term: 'creditors voluntary liquidation', kw: 'k4', imp: 50, ctr: 0.05, cpc: 12, cvr: 0.07, org: 5.4, page: '/what-are-the-benefits-of-a-cvl', orgImp: 300 },
  { term: 'cvl liquidation cost', kw: 'k6', imp: 30, ctr: 0.07, cpc: 15, cvr: 0.1, org: 12, page: '/company-liquidate', orgImp: 90 },
  { term: 'company liquidation cost', kw: 'k6', imp: 55, ctr: 0.06, cpc: 16, cvr: 0.09, org: 11, page: '/company-liquidate', orgImp: 150 },
  { term: 'liquidation', kw: 'k5', imp: 120, ctr: 0.02, cpc: 6, cvr: 0.012, org: 18, page: '/', orgImp: 900, wrong: 0.2 },
  // Broad "liquidation" drifting: job-seekers, students, and people buying liquidation stock
  { term: 'insolvency practitioner jobs', kw: 'k5', imp: 60, ctr: 0.04, cpc: 4, cvr: 0, org: null, drift: true },
  { term: 'insolvency practitioner course', kw: 'k5', imp: 30, ctr: 0.04, cpc: 4.5, cvr: 0, org: null, drift: true },
  { term: 'liquidation pallets uk', kw: 'k5', imp: 90, ctr: 0.05, cpc: 2.5, cvr: 0.006, org: null, drift: true, wrong: 0.98 },
  { term: 'what is liquidation', kw: 'k5', imp: 40, ctr: 0.02, cpc: 3, cvr: 0, org: null, drift: true },
  // Bounce back loans
  { term: 'cant repay bounce back loan', kw: 'k7', imp: 45, ctr: 0.07, cpc: 9, cvr: 0.08, org: null },
  { term: 'bounce back loan liquidation', kw: 'k7', imp: 30, ctr: 0.07, cpc: 10, cvr: 0.09, org: 14, page: '/faq', orgImp: 80 },
  { term: 'close company with bounce back loan', kw: 'k7', imp: 25, ctr: 0.06, cpc: 10, cvr: 0.07, org: null },
  // Winding-up petitions
  { term: 'winding up petition', kw: 'k8', imp: 50, ctr: 0.06, cpc: 18, cvr: 0.07, org: 13, page: '/faq', orgImp: 150 },
  { term: 'received winding up petition from hmrc', kw: 'k8', imp: 20, ctr: 0.08, cpc: 20, cvr: 0.12, org: null },
  { term: 'stop winding up petition', kw: 'k8', imp: 25, ctr: 0.07, cpc: 19, cvr: 0.08, org: null },
  // Members' voluntary liquidation
  { term: 'members voluntary liquidation', kw: 'k9', imp: 40, ctr: 0.06, cpc: 10, cvr: 0.07, org: null },
  { term: 'mvl cost', kw: 'k9', imp: 25, ctr: 0.07, cpc: 9, cvr: 0.08, org: null },
  { term: 'close solvent company tax efficiently', kw: 'k10', imp: 20, ctr: 0.06, cpc: 8, cvr: 0.05, org: null },
  // Broad "business debt help": also matches personal debt
  { term: 'business debt help', kw: 'k11', imp: 60, ctr: 0.05, cpc: 8, cvr: 0.05, org: null, wrong: 0.15 },
  { term: 'personal debt help', kw: 'k11', imp: 55, ctr: 0.05, cpc: 6, cvr: 0.06, org: null, wrong: 0.95 },
  { term: 'iva advice', kw: 'k11', imp: 35, ctr: 0.05, cpc: 7, cvr: 0.07, org: null, wrong: 0.97 },
  { term: 'debt management plan', kw: 'k11', imp: 30, ctr: 0.05, cpc: 6, cvr: 0.05, org: null, wrong: 0.97 },
]

const ORGANIC_ONLY = [
  { term: 'what happens when a company goes into liquidation', org: 7, page: '/company-liquidate', orgImp: 500 },
  { term: 'how long does liquidation take', org: 5.5, page: '/company-liquidate', orgImp: 300 },
  { term: 'liquidation cost uk', org: 10.5, page: '/company-liquidate', orgImp: 350 },
  { term: 'director redundancy pay insolvent company', org: 6, page: '/faq', orgImp: 220 },
  { term: 'can i lose my house if my company goes into liquidation', org: 8, page: '/faq', orgImp: 180 },
  { term: 'directors loan account liquidation', org: 9.5, page: '/faq', orgImp: 160 },
  { term: 'liquidation calculator', org: 3, page: '/calculator', orgImp: 90 },
  { term: 'benefits of cvl', org: 2.2, page: '/what-are-the-benefits-of-a-cvl', orgImp: 110 },
  { term: 'do i need to liquidate my company', org: 1.8, page: '/do-i-need-to-liquidate-my-company', orgImp: 70 },
  { term: 'insolvency practitioner stoke on trent', org: 4, page: '/about-us', orgImp: 60 },
  { term: 'easy liquidation stoke', org: 1.1, page: '/contact', orgImp: 20 },
]

const H = {
  price: 'Liquidation From £1,499',
  free: 'Free Confidential Consultation',
  ip: 'Licensed Insolvency Experts',
  years: "30+ Years' Experience",
  rated: 'Rated 5★ by Directors',
  bodies: 'IPA & R3 Members',
  phone: 'Call 0333 052 2833 Now',
  hidden: 'No Hidden Fees',
  expert: 'Speak to an Expert Today',
  hmrc: 'Act Now Before HMRC Does',
  pressure: 'Stop Creditor Pressure Today',
  director: 'Protect Yourself as a Director',
}
const D = {
  free: 'Close your company properly. Free, confidential consultation with a licensed IP.',
  price: "Liquidation from £1,499 with no hidden fees. Over 30 years' experience. Call today.",
  bodies: 'Members of the IPA and R3. We deal with HMRC, banks and creditors for you.',
  urgent: 'Act now, creditor pressure only grows. Speak to an insolvency expert today.',
}

export const EL_ADS: AdAccountPreset = {
  id: 'easy-liquidation',
  workspace: 'Easy Liquidation',
  brand: { name: 'Easy Liquidation', terms: ['easy liquidation', 'easyliquidation'] },
  site: SITE,
  keywords: [
    ['k1', 'ag_brand', 'c_brand', 'easy liquidation', 'EXACT'],
    ['k2', 'ag_brand', 'c_brand', 'easyliquidation', 'EXACT'],
    ['k3', 'ag_cvl', 'c_cvl', 'liquidate my company', 'PHRASE'],
    ['k4', 'ag_cvl', 'c_cvl', 'creditors voluntary liquidation', 'PHRASE'],
    ['k5', 'ag_cvl', 'c_cvl', 'liquidation', 'BROAD'],
    ['k6', 'ag_cvl', 'c_cvl', 'company liquidation cost', 'PHRASE'],
    ['k7', 'ag_bbl', 'c_cvl', 'bounce back loan', 'PHRASE'],
    ['k8', 'ag_wup', 'c_urgent', 'winding up petition', 'PHRASE'],
    ['k9', 'ag_mvl', 'c_mvl', 'members voluntary liquidation', 'PHRASE'],
    ['k10', 'ag_mvl', 'c_mvl', 'close solvent company', 'PHRASE'],
    ['k11', 'ag_debt', 'c_debt', 'business debt help', 'BROAD'],
  ],
  adGroups: [
    { adGroupId: 'ag_brand', campaignId: 'c_brand', name: 'Brand' },
    { adGroupId: 'ag_cvl', campaignId: 'c_cvl', name: 'Company liquidation (CVL)' },
    { adGroupId: 'ag_bbl', campaignId: 'c_cvl', name: 'Bounce back loans' },
    { adGroupId: 'ag_wup', campaignId: 'c_urgent', name: 'Winding-up petitions' },
    { adGroupId: 'ag_mvl', campaignId: 'c_mvl', name: "Members' voluntary liquidation" },
    { adGroupId: 'ag_debt', campaignId: 'c_debt', name: 'Business debt (broad)' },
  ],
  terms: TERMS,
  organicOnly: ORGANIC_ONLY,
  pages: PAGES,
  auction: [
    { keywordId: 'k1', competitorDomain: 'closefast.example', overlapRate: 0.35 },
    { keywordId: 'k3', competitorDomain: 'rescue-rival.example', overlapRate: 0.55 },
    { keywordId: 'k4', competitorDomain: 'rescue-rival.example', overlapRate: 0.4 },
    { keywordId: 'k5', competitorDomain: 'ipdirect.example', overlapRate: 0.3 },
    { keywordId: 'k6', competitorDomain: 'closefast.example', overlapRate: 0.6 },
    { keywordId: 'k7', competitorDomain: 'rescue-rival.example', overlapRate: 0.45 },
    { keywordId: 'k8', competitorDomain: 'ipdirect.example', overlapRate: 0.5 },
    { keywordId: 'k9', competitorDomain: 'closefast.example', overlapRate: 0.25 },
    { keywordId: 'k10', competitorDomain: 'closefast.example', overlapRate: 0.2 },
    { keywordId: 'k11', competitorDomain: 'ipdirect.example', overlapRate: 0.3 },
  ],
  pinned: { ag_brand: [0], ag_cvl: [0], ag_bbl: [0], ag_wup: [0], ag_mvl: [0], ag_debt: [0] },
  assets: {
    ag_brand: {
      h: ['Easy Liquidation Official Site', H.price, H.free, H.ip, H.years, H.rated, H.bodies, H.phone, H.expert, H.hidden],
      d: [D.free, D.price, D.bodies, D.urgent],
    },
    ag_cvl: {
      h: ['Liquidate Your Company', H.price, H.free, H.ip, H.years, H.rated, H.pressure, H.phone, H.bodies, H.hidden, H.director, H.hmrc, H.expert],
      d: [D.free, D.price, D.bodies, D.urgent],
    },
    ag_bbl: {
      h: ['Bounce Back Loan Worries?', "Can't Repay Your BBL?", H.price, H.free, H.ip, H.rated, H.years, H.director, H.hidden, H.expert, H.hmrc],
      d: [D.free, D.price, D.bodies, D.urgent],
    },
    ag_wup: {
      h: ['Winding Up Petition Help', 'Got a Winding Up Petition?', H.free, H.ip, H.rated, H.years, H.phone, 'Act Before the Hearing', H.hidden, H.expert, H.bodies],
      d: [D.free, D.price, D.bodies, D.urgent],
    },
    ag_mvl: {
      h: ["Members' Voluntary Liquidation", 'Close Your Solvent Company', 'Tax-Efficient Company Closure', H.hidden, H.ip, H.years, H.rated, H.free, H.expert, H.bodies],
      d: [D.free, D.bodies, "Over 30 years' experience closing solvent companies. No hidden fees.", D.urgent],
    },
    ag_debt: {
      h: ['Business Debt Help', 'Company Debts Mounting?', H.free, H.ip, H.price, H.rated, H.pressure, H.years, H.expert, H.hmrc],
      d: [D.free, D.price, D.bodies, D.urgent],
    },
  },
  competitors: ['closefast', 'rescue rival', 'ipdirect'],
  bannedTerms: ['guaranteed', 'debt free', 'write off all your debts'],
  dataNote:
    'Pages, titles, services, claims and FAQ questions are from easyliquidation.co.uk (read 29 Sep 2026). Ad, Search Console and enquiry data are simulated; competitors are fictional.',
}

export const EL_BUSINESS: BusinessPreset = {
  id: 'easy-liquidation',
  business: {
    services: [
      {
        id: 'cvl',
        name: "Creditors' Voluntary Liquidation (CVL)",
        keywords: ['liquidate', 'liquidation', 'cvl', 'creditors voluntary', 'insolvent', 'bounce back', 'close my company'],
        adGroupIds: ['ag_cvl', 'ag_bbl', 'ag_debt'],
        marginPerCustomer: 1800,
        weeklyCapacity: 10,
        bookedThisWeek: 6,
        landingPages: [`${SITE}/company-liquidate`],
        growthPriority: 'maintain',
      },
      {
        id: 'winding_up',
        name: 'Winding-up petition help',
        keywords: ['winding up', 'petition', 'hearing', 'court'],
        adGroupIds: ['ag_wup'],
        marginPerCustomer: 2400,
        weeklyCapacity: 3,
        bookedThisWeek: 3,
        landingPages: [],
        growthPriority: 'maintain',
      },
      {
        id: 'mvl',
        name: "Members' Voluntary Liquidation (MVL)",
        keywords: ['mvl', 'members voluntary', 'solvent', 'retire', 'retiring', 'tax efficient', 'tax-efficiently'],
        adGroupIds: ['ag_mvl'],
        marginPerCustomer: 2000,
        weeklyCapacity: 4,
        bookedThisWeek: 1,
        landingPages: [],
        growthPriority: 'grow',
      },
    ],
    serviceAreas: ['GB'],
    notOffered: [
      'personal debt',
      'iva',
      'bankruptcy',
      'debt management plan',
      'credit card debt',
      'sole trader',
      'pallets',
      'liquidation stock',
    ],
    followUpSlaHours: 2,
    unreachableAfterAttempts: 3,
    maxWeeklyBudgetChange: 0.2,
  },
  newKeywords: [],
  newAdGroups: [],
  newTerms: [],
  extraPages: [],
  messages: {
    cvl: [
      "We owe HMRC about £40k and can't pay. Is the £1,499 fee all-in or are there extras?",
      'Will I be personally liable for the company debts if we liquidate?',
      'How long does a CVL take from start to finish?',
      'Can I claim director redundancy pay?',
      "What happens to my director's loan account?",
      'Could I lose my home if the company goes into liquidation?',
      "I have a £45k bounce back loan I can't repay. Can I still liquidate?",
      'Will the bank come after me personally for the bounce back loan?',
    ],
    winding_up: [
      'HMRC have issued a winding up petition and the hearing is in 10 days. Can you act this week?',
      'We received a winding up petition yesterday. How quickly can you start?',
      "Can a winding up petition be stopped once it's advertised?",
    ],
    mvl: [
      "I'm retiring and want to close my solvent company tax-efficiently. What does an MVL cost?",
      'How long does an MVL take and when do I get the funds?',
      'Is an MVL worth it for £80k of retained profit, or should I just strike off?',
    ],
    wrong: [
      'I have £18k of credit card debt personally, can you set up an IVA for me?',
      'Looking for a debt management plan for my personal loans.',
      'Sole trader with debts, I need bankruptcy advice.',
      'Do you sell liquidation pallets? Looking for Amazon returns stock.',
    ],
    spam: [
      'Best SEO services cheap!!! visit http://rank-fast.example and www.cheap-links.example',
      'Guest post offer http://links.example/deal http://links.example/pay',
      'asdkjh qwe zxc',
    ],
  },
  lost: {
    cvl: [
      ['Fee was more than the £1,499 they expected once we looked at the assets', 0.3],
      ['Went with a local insolvency practitioner', 0.25],
      ['Trying a Time to Pay arrangement with HMRC first', 0.2],
      ['Worried about being personally liable for the bounce back loan', 0.15],
      ['Not now, want to wait until the year end', 0.1],
    ],
    winding_up: [
      ['Needed someone this week and we were fully booked', 0.5],
      ['Went with an IP who could start sooner', 0.3],
      ['Paid the petition debt instead', 0.2],
    ],
    mvl: [
      ['Their accountant recommended another firm', 0.4],
      ['Wanted to wait until the new tax year', 0.35],
      ['Not clear what the MVL fee includes', 0.25],
    ],
  },
  close: { cvl: 0.3, winding_up: 0.35, mvl: 0.4 },
  localAreas: ['ST', 'M', 'B', 'LS', 'L', 'NG', 'CV', 'WS', 'SK', 'CW', 'DE', 'BS', 'CF', 'NE', 'EC', 'SE'],
  brandAdGroup: 'ag_brand',
  spamAdGroup: 'ag_debt',
  areaRisk: { ag_debt: 0.06 },
  organicServiceMix: ['cvl', 'cvl', 'cvl', 'winding_up', 'mvl'],
  defaultLanding: `${SITE}/`,
  wrongShare: Object.fromEntries(TERMS.filter((t) => t.wrong).map((t) => [t.term, t.wrong!])),
  wrongMessageHints: [
    ['pallets', /pallet/],
    ['iva', /iva/],
    ['debt management', /debt management/],
    ['credit card', /personal debt/],
  ],
}
