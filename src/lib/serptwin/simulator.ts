import { addBusiness, CY_BUSINESS, type BusinessPreset } from './business-sim'
import { EL_ADS, EL_BUSINESS } from './presets/easy-liquidation'
import type {
  AdAssetRow,
  AdGroupRow,
  AuctionRow,
  Intent,
  KeywordRow,
  MatchType,
  OrganicRow,
  PageMeta,
  SearchTermRow,
  SerpTwinInput,
} from './types'
import { binomial, gaussian, poisson, rng, type Rng } from './stats'
import { extractClaims, type Claim } from './claims'
import { classifyIntent } from './intent'
import { shiftDate } from './engines/drift'
import type { PauseTestDay, PauseTestDesign } from './engines/experiment'

/**
 * The SERP Twin simulator.
 *
 * Produces eight weeks of search-terms, asset, auction and Search Console
 * rows for the seeded workspace, with **known ground truth planted in it**:
 * a CTR curve, per-claim effects on CTR and conversion, a broad-match
 * keyword that drifts into job-seekers in the final fortnight, and a true
 * organic recapture rate for the pause test.
 *
 * The tests do not check that the engines produce *some* output; they check
 * that the engines recover what was planted. That is the only honest way to
 * test an estimator without a live account.
 *
 * Every row it produces is flagged `simulated: true`, and the UI labels it.
 */

export const TRUTH = {
  ctrCurve: { a: 0.34, b: 1.25 },
  recapture: 0.78,
  driftKeyword: 'k5',
  driftStartsDaysBeforeEnd: 14,
  /** Multiplicative effects on (CTR, CVR) for non-navigational intents. */
  claims: {
    risk_reversal: [1.12, 1.25],
    proof: [1.16, 1.05],
    price: [1.08, 1.0],
    speed: [1.05, 1.03],
    outcome: [1.0, 1.08],
    urgency: [1.04, 0.84],
    feature: [0.93, 0.97],
    authority: [1.03, 1.02],
    audience: [1.04, 1.06],
    cta: [1.0, 1.0],
    specificity: [1.0, 1.0],
  } as Record<Claim, [number, number]>,
  /** Price for comparison shoppers: more clicks, fewer buyers — the clickbait case. */
  commercialPriceOverride: [1.14, 0.8] as [number, number],
  /** Brand searchers have decided already; claims move them far less. */
  navigationalDamping: 0.35,
} as const

const END: string = '2026-09-27'
/**
 * Google's asset report covers the ad's lifetime, not the analysis window.
 * The simulated RSAs have been live ~48 weeks, six times the 8-week window.
 */
const ASSET_LIFETIME_FACTOR = 6
const DAYS = 56
const BRAND = { name: 'CY Group', terms: ['cy group', 'cygroup'] }
const SITE = 'https://www.cygroup.example'

export interface TermSpec {
  term: string
  kw: string
  imp: number // paid impressions per day at baseline
  ctr: number
  cpc: number
  cvr: number
  org: number | null // organic average position
  page?: string
  orgImp?: number // organic impressions per day
  drift?: boolean // appears only in the last fortnight, ramping up
  /** Share of this search's enquiries that want something the business does not offer. */
  wrong?: number
}

/**
 * Everything that makes one simulated ad account different from another:
 * the brand, its keywords, the searches they match, its pages and ads. The
 * engines never see a preset; they see the rows the simulator draws from it.
 */
export interface AdAccountPreset {
  id: string
  workspace: string
  brand: { name: string; terms: string[] }
  site: string
  keywords: [string, string, string, string, MatchType][]
  adGroups: AdGroupRow[]
  terms: TermSpec[]
  organicOnly: { term: string; org: number; page: string; orgImp: number }[]
  pages: PageMeta[]
  auction: AuctionRow[]
  pinned: Record<string, number[]>
  assets: Record<string, { h: string[]; d: string[] }>
  competitors: string[]
  bannedTerms: string[]
  /** Shown beside the simulated badge: what in this account is real and what is not. */
  dataNote?: string
}

const KEYWORDS: [string, string, string, string, MatchType][] = [
  ['k1', 'ag_brand', 'c_brand', 'cy group', 'EXACT'],
  ['k2', 'ag_brand', 'c_brand', 'cy group platform', 'EXACT'],
  ['k3', 'ag_brand', 'c_brand', 'cy group login', 'EXACT'],
  ['k4', 'ag_brand', 'c_brand', 'cy group pricing', 'EXACT'],
  ['k5', 'ag_ma', 'c_ma', 'marketing automation', 'BROAD'],
  ['k6', 'ag_ma', 'c_ma', 'marketing automation software', 'PHRASE'],
  ['k7', 'ag_ma', 'c_ma', 'marketing automation platform', 'PHRASE'],
  ['k8', 'ag_compare', 'c_ma', 'best marketing automation tools', 'PHRASE'],
  ['k9', 'ag_compare', 'c_ma', 'pipeloop alternative', 'PHRASE'],
  ['k10', 'ag_email', 'c_email', 'email marketing platform', 'PHRASE'],
  ['k11', 'ag_email', 'c_email', 'email automation software', 'PHRASE'],
  ['k12', 'ag_ai', 'c_email', 'ai marketing tools', 'BROAD'],
]

const AD_GROUPS: AdGroupRow[] = [
  { adGroupId: 'ag_brand', campaignId: 'c_brand', name: 'Brand' },
  { adGroupId: 'ag_ma', campaignId: 'c_ma', name: 'Marketing automation' },
  { adGroupId: 'ag_compare', campaignId: 'c_ma', name: 'Comparisons' },
  { adGroupId: 'ag_email', campaignId: 'c_email', name: 'Email platform' },
  { adGroupId: 'ag_ai', campaignId: 'c_email', name: 'AI content' },
]

const TERMS: TermSpec[] = [
  // Brand
  { term: 'cy group', kw: 'k1', imp: 210, ctr: 0.36, cpc: 0.85, cvr: 0.09, org: 1.0, page: '/', orgImp: 900 },
  {
    term: 'cy group platform',
    kw: 'k2',
    imp: 40,
    ctr: 0.3,
    cpc: 0.9,
    cvr: 0.08,
    org: 1.0,
    page: '/',
    orgImp: 150,
  },
  {
    term: 'cy group login',
    kw: 'k3',
    imp: 95,
    ctr: 0.42,
    cpc: 0.45,
    cvr: 0.004,
    org: 1.0,
    page: '/login',
    orgImp: 520,
  },
  {
    term: 'cy group pricing',
    kw: 'k4',
    imp: 30,
    ctr: 0.33,
    cpc: 1.3,
    cvr: 0.1,
    org: 1.2,
    page: '/pricing',
    orgImp: 110,
  },
  // Marketing automation — k5 broad (drifts)
  {
    term: 'marketing automation',
    kw: 'k5',
    imp: 260,
    ctr: 0.045,
    cpc: 5.8,
    cvr: 0.035,
    org: 8.4,
    page: '/marketing-automation',
    orgImp: 1400,
  },
  {
    term: 'marketing automation tools',
    kw: 'k5',
    imp: 120,
    ctr: 0.05,
    cpc: 5.2,
    cvr: 0.04,
    org: 6.1,
    page: '/marketing-automation',
    orgImp: 600,
  },
  {
    term: 'marketing automation uk',
    kw: 'k5',
    imp: 70,
    ctr: 0.055,
    cpc: 5.5,
    cvr: 0.045,
    org: 4.8,
    page: '/marketing-automation',
    orgImp: 260,
  },
  {
    term: 'b2b marketing automation',
    kw: 'k5',
    imp: 85,
    ctr: 0.06,
    cpc: 6.4,
    cvr: 0.028,
    org: 1.6,
    page: '/marketing-automation',
    orgImp: 380,
  },
  {
    term: 'free trial marketing automation',
    kw: 'k5',
    imp: 18,
    ctr: 0.07,
    cpc: 4.1,
    cvr: 0.09,
    org: 9.5,
    page: '/pricing',
    orgImp: 40,
  },
  {
    term: 'marketing automation software reviews',
    kw: 'k5',
    imp: 22,
    ctr: 0.04,
    cpc: 4.8,
    cvr: 0.02,
    org: 13,
    page: '/customers',
    orgImp: 70,
  },
  {
    term: 'what is marketing automation',
    kw: 'k5',
    imp: 30,
    ctr: 0.02,
    cpc: 3.1,
    cvr: 0.0,
    org: 14,
    page: '/blog/what-is-marketing-automation',
    orgImp: 400,
  },
  {
    term: 'marketing automation jobs',
    kw: 'k5',
    imp: 150,
    ctr: 0.05,
    cpc: 3.4,
    cvr: 0,
    org: null,
    drift: true,
  },
  {
    term: 'marketing automation course',
    kw: 'k5',
    imp: 90,
    ctr: 0.05,
    cpc: 3.9,
    cvr: 0,
    org: null,
    drift: true,
  },
  {
    term: 'marketing automation salary uk',
    kw: 'k5',
    imp: 60,
    ctr: 0.045,
    cpc: 3.2,
    cvr: 0,
    org: null,
    drift: true,
  },
  {
    term: 'marketing automation certification',
    kw: 'k5',
    imp: 45,
    ctr: 0.04,
    cpc: 4.0,
    cvr: 0,
    org: null,
    drift: true,
  },
  {
    term: 'marketing automation examples',
    kw: 'k5',
    imp: 70,
    ctr: 0.03,
    cpc: 3.0,
    cvr: 0,
    org: null,
    drift: true,
  },
  {
    term: 'marketing automation setup guide',
    kw: 'k5',
    imp: 40,
    ctr: 0.03,
    cpc: 3.3,
    cvr: 0,
    org: null,
    drift: true,
  },
  {
    term: 'free marketing automation software',
    kw: 'k5',
    imp: 55,
    ctr: 0.05,
    cpc: 3.6,
    cvr: 0,
    org: null,
    drift: true,
  },
  // k6 / k7
  {
    term: 'marketing automation software',
    kw: 'k6',
    imp: 140,
    ctr: 0.05,
    cpc: 7.2,
    cvr: 0.045,
    org: 3.1,
    page: '/marketing-automation',
    orgImp: 520,
  },
  {
    term: 'marketing automation software for small business',
    kw: 'k6',
    imp: 45,
    ctr: 0.05,
    cpc: 5.9,
    cvr: 0.05,
    org: null,
  },
  {
    term: 'marketing automation software pricing',
    kw: 'k6',
    imp: 35,
    ctr: 0.06,
    cpc: 6.5,
    cvr: 0.06,
    org: 5.6,
    page: '/pricing',
    orgImp: 150,
  },
  {
    term: 'marketing automation platform',
    kw: 'k7',
    imp: 110,
    ctr: 0.055,
    cpc: 6.6,
    cvr: 0.05,
    org: 2.3,
    page: '/marketing-automation',
    orgImp: 430,
  },
  {
    term: 'marketing automation platform uk',
    kw: 'k7',
    imp: 45,
    ctr: 0.06,
    cpc: 6.1,
    cvr: 0.05,
    org: 1.7,
    page: '/marketing-automation',
    orgImp: 170,
  },
  {
    term: 'enterprise marketing automation platform',
    kw: 'k7',
    imp: 30,
    ctr: 0.045,
    cpc: 8.4,
    cvr: 0.05,
    org: null,
  },
  // Comparisons
  {
    term: 'best marketing automation tools',
    kw: 'k8',
    imp: 160,
    ctr: 0.04,
    cpc: 4.6,
    cvr: 0.025,
    org: 7.4,
    page: '/blog/best-marketing-automation-tools',
    orgImp: 900,
  },
  {
    term: 'marketing automation tools comparison',
    kw: 'k8',
    imp: 60,
    ctr: 0.04,
    cpc: 4.2,
    cvr: 0.02,
    org: 11,
    page: '/blog/best-marketing-automation-tools',
    orgImp: 300,
  },
  {
    term: 'best marketing automation tools 2026',
    kw: 'k8',
    imp: 55,
    ctr: 0.045,
    cpc: 4.4,
    cvr: 0.022,
    org: 6.5,
    page: '/blog/best-marketing-automation-tools',
    orgImp: 260,
  },
  {
    term: 'pipeloop alternative',
    kw: 'k9',
    imp: 70,
    ctr: 0.065,
    cpc: 5.1,
    cvr: 0.05,
    org: 3.4,
    page: '/compare/pipeloop',
    orgImp: 180,
  },
  {
    term: 'pipeloop vs cy group',
    kw: 'k9',
    imp: 20,
    ctr: 0.12,
    cpc: 2.8,
    cvr: 0.08,
    org: 1.4,
    page: '/compare/pipeloop',
    orgImp: 80,
  },
  // Email
  {
    term: 'email marketing platform',
    kw: 'k10',
    imp: 190,
    ctr: 0.04,
    cpc: 5.4,
    cvr: 0.03,
    org: 12,
    page: '/email-marketing',
    orgImp: 700,
  },
  {
    term: 'b2b email marketing platform',
    kw: 'k10',
    imp: 60,
    ctr: 0.055,
    cpc: 5.9,
    cvr: 0.045,
    org: 4.2,
    page: '/email-marketing',
    orgImp: 190,
  },
  { term: 'email marketing platform uk', kw: 'k10', imp: 50, ctr: 0.05, cpc: 5.0, cvr: 0.035, org: null },
  {
    term: 'email automation software',
    kw: 'k11',
    imp: 85,
    ctr: 0.05,
    cpc: 4.9,
    cvr: 0.04,
    org: 6.0,
    page: '/email-marketing',
    orgImp: 300,
  },
  {
    term: 'email automation software for b2b',
    kw: 'k11',
    imp: 40,
    ctr: 0.06,
    cpc: 5.6,
    cvr: 0.05,
    org: 2.1,
    page: '/email-marketing',
    orgImp: 150,
  },
  // AI
  {
    term: 'ai marketing tools',
    kw: 'k12',
    imp: 150,
    ctr: 0.045,
    cpc: 3.9,
    cvr: 0.025,
    org: 9.2,
    page: '/ai-content',
    orgImp: 800,
  },
  {
    term: 'ai content generator for marketing',
    kw: 'k12',
    imp: 70,
    ctr: 0.05,
    cpc: 3.6,
    cvr: 0.03,
    org: null,
  },
  {
    term: 'ai tools for marketing teams',
    kw: 'k12',
    imp: 55,
    ctr: 0.055,
    cpc: 4.2,
    cvr: 0.035,
    org: 2.6,
    page: '/ai-content',
    orgImp: 210,
  },
  {
    term: 'ai marketing tools free',
    kw: 'k12',
    imp: 35,
    ctr: 0.04,
    cpc: 2.2,
    cvr: 0.0,
    org: 15,
    page: '/ai-content',
    orgImp: 120,
  },
]

/** Organic-only searches: no paid coverage, but they give the CTR curve its shape. */
const ORGANIC_ONLY: { term: string; org: number; page: string; orgImp: number }[] = [
  { term: 'brand guardrails for ai content', org: 1.3, page: '/ai-content', orgImp: 160 },
  { term: 'campaign approval workflow', org: 2.2, page: '/marketing-automation', orgImp: 240 },
  {
    term: 'marketing automation statistics',
    org: 4.4,
    page: '/blog/what-is-marketing-automation',
    orgImp: 380,
  },
  {
    term: 'marketing automation benefits',
    org: 5.3,
    page: '/blog/what-is-marketing-automation',
    orgImp: 420,
  },
  { term: 'email marketing tips', org: 7.6, page: '/email-marketing', orgImp: 600 },
  { term: 'email marketing best practices', org: 10.4, page: '/email-marketing', orgImp: 700 },
  { term: 'b2b marketing strategy', org: 16.5, page: '/blog/what-is-marketing-automation', orgImp: 900 },
  { term: 'marketing workflow software', org: 3.5, page: '/marketing-automation', orgImp: 260 },
  { term: 'content approval software', org: 8.5, page: '/marketing-automation', orgImp: 300 },
]

const PAGES: PageMeta[] = [
  {
    url: `${SITE}/`,
    title: 'CY Group | Marketing Automation Platform',
    metaDescription:
      'The official CY Group site. Our marketing automation platform helps teams launch campaigns fast, from brief to publish.',
  },
  {
    url: `${SITE}/login`,
    title: 'Log in | CY Group',
    metaDescription: 'Sign in to your CY Group workspace.',
  },
  {
    url: `${SITE}/pricing`,
    title: 'Pricing | CY Group',
    metaDescription:
      'Plans for every team size. Compare features and choose the right plan for your marketing team.',
  },
  {
    url: `${SITE}/marketing-automation`,
    title: 'Marketing Automation Software | CY Group',
    metaDescription:
      'Automate campaigns across email, social and paid search. Approvals, brand guardrails and analytics built in for modern marketing teams.',
  },
  {
    url: `${SITE}/email-marketing`,
    title: 'Email Marketing Platform | CY Group',
    metaDescription:
      'Email automation built for B2B teams: segmentation, analytics and consent management in one platform.',
  },
  {
    url: `${SITE}/ai-content`,
    title: 'AI Marketing Tools | CY Group',
    metaDescription:
      'Generate on-brand content with AI, checked against your guardrails before anything goes live.',
  },
  {
    url: `${SITE}/customers`,
    title: 'Customer Stories | CY Group',
    metaDescription: 'How marketing teams plan, create and publish with CY Group.',
  },
  {
    url: `${SITE}/compare/pipeloop`,
    title: 'CY Group vs Pipeloop: Feature Comparison',
    metaDescription:
      'A side-by-side comparison of CY Group and Pipeloop across automation, approvals and reporting.',
  },
  {
    url: `${SITE}/blog/best-marketing-automation-tools`,
    title: 'The Best Marketing Automation Tools in 2026',
    metaDescription:
      'We compared the leading marketing automation tools on features, pricing and ease of use.',
  },
  {
    url: `${SITE}/blog/what-is-marketing-automation`,
    title: 'What Is Marketing Automation? A Complete Guide',
    metaDescription: 'Marketing automation explained: what it is, how it works, and where to start.',
  },
]

const AUCTION: AuctionRow[] = [
  { keywordId: 'k1', competitorDomain: 'pipeloop.example', overlapRate: 0.42 },
  { keywordId: 'k2', competitorDomain: 'pipeloop.example', overlapRate: 0.12 },
  { keywordId: 'k4', competitorDomain: 'sendwise.example', overlapRate: 0.08 },
  { keywordId: 'k5', competitorDomain: 'sendwise.example', overlapRate: 0.3 },
  { keywordId: 'k5', competitorDomain: 'funnelforge.example', overlapRate: 0.22 },
  { keywordId: 'k6', competitorDomain: 'funnelforge.example', overlapRate: 0.55 },
  { keywordId: 'k7', competitorDomain: 'funnelforge.example', overlapRate: 0.2 },
  { keywordId: 'k8', competitorDomain: 'funnelforge.example', overlapRate: 0.5 },
  { keywordId: 'k9', competitorDomain: 'pipeloop.example', overlapRate: 0.6 },
  { keywordId: 'k10', competitorDomain: 'sendwise.example', overlapRate: 0.48 },
  { keywordId: 'k11', competitorDomain: 'sendwise.example', overlapRate: 0.15 },
  { keywordId: 'k12', competitorDomain: 'funnelforge.example', overlapRate: 0.25 },
]

/**
 * Headlines pinned by the advertiser. A pinned headline shows in every
 * impression, which is how most accounts run: keyword in H1, product in H2.
 */
const PINNED: Record<string, number[]> = {
  ag_brand: [0],
  ag_ma: [0],
  ag_compare: [0],
  ag_email: [0, 1],
  ag_ai: [0],
}

/** RSA assets per ad group. Every headline is checked against Google's 30-character limit at build time. */
const ASSETS: Record<string, { h: string[]; d: string[] }> = {
  ag_brand: {
    h: [
      'CY Group Official Site',
      'Marketing Automation Platform',
      'Book a Demo Today',
      'Trusted by 1,200+ Teams',
      'Cancel Anytime, No Contract',
      'Rated 4.8★ on G2',
      'Plans From £49/Month',
      'Log In to Your Workspace',
      'Launch Campaigns in Minutes',
      'AI-Powered Workflows',
      'Limited Offer — Ends Friday',
      'ISO 27001 Certified',
      'Built for B2B Marketing Teams',
      'More Pipeline, Less Busywork',
    ],
    d: [
      'The official CY Group site. Plan, create and publish every campaign from one place.',
      'Try it free for 14 days — no card needed. Cancel anytime.',
      'Trusted by 1,200+ marketing teams. Approvals and brand guardrails built in.',
      'Act now — autumn pricing ends this week. Book your demo today.',
    ],
  },
  ag_ma: {
    h: [
      'Marketing Automation Platform',
      'Automate Every Campaign',
      'Cancel Anytime, No Contract',
      'Trusted by 1,200+ Teams',
      'Book a Demo Today',
      'Plans From £49/Month',
      'Launch Campaigns in Minutes',
      'More Pipeline, Less Busywork',
      'Built for B2B Marketing Teams',
      'Limited Offer — Ends Friday',
      'AI-Powered Workflows',
      'Free 14-Day Trial',
      'ISO 27001 Certified',
      'Rated 4.8★ on G2',
      'Drag-and-Drop Automation',
    ],
    d: [
      'Plan, create and publish from one platform. Try it free for 14 days — no card needed.',
      'Approvals, brand guardrails and analytics built in. Trusted by 1,200+ marketing teams.',
      'Automate email, social and paid search with AI. Grow pipeline without growing headcount.',
      'Act now — autumn pricing ends this week. Book your demo today.',
    ],
  },
  ag_compare: {
    h: [
      'Compare Top Automation Tools',
      'See Why Teams Switch',
      'Rated 4.8★ on G2',
      'Cancel Anytime, No Contract',
      'Trusted by 1,200+ Teams',
      'Plans From £49/Month',
      'Half the Price of Pipeloop',
      'Switch in Under a Week',
      'More Pipeline, Less Busywork',
      'Limited Offer — Ends Friday',
      'AI-Powered Workflows',
      'Free 14-Day Trial',
      'Built for B2B Marketing Teams',
      'Real-Time Analytics Dashboard',
    ],
    d: [
      'Compare features side by side. Try it free for 14 days — no card needed.',
      'Rated 4.8★ on G2 by 300+ reviewers. See why teams switch from Pipeloop.',
      'Transparent pricing from £49/month. No setup fee, cancel anytime.',
      'Last chance — switching offer ends this week. Book a demo now.',
    ],
  },
  ag_email: {
    h: [
      'B2B Email Marketing Platform',
      'Email Automation Software',
      'Cancel Anytime, No Contract',
      'Segment by Behaviour & Intent',
      'Book a Demo Today',
      'Plans From £49/Month',
      'Send in Minutes, Not Days',
      'More Replies, More Pipeline',
      'Built for B2B Marketing Teams',
      'Limited Offer — Ends Friday',
      'AI Subject Line Testing',
      'Free 14-Day Trial',
      'GDPR-Compliant by Design',
      'Deliverability You Can See',
    ],
    d: [
      'Consent and suppression built in. Try it free for 14 days — no card needed.',
      'Trusted by 1,200+ teams to send on-brand B2B email at scale.',
      'Segmentation, automation and analytics in one platform. Grow revenue from every send.',
      'Hurry — autumn pricing ends this week. Book your demo today.',
    ],
  },
  ag_ai: {
    h: [
      'AI Marketing Tools',
      'On-Brand AI Content',
      'Your Brand Voice, at Scale',
      'Trusted by 1,200+ Teams',
      'Book a Demo Today',
      'Plans From £49/Month',
      'Draft Campaigns in Minutes',
      'More Output, Same Headcount',
      'Built for B2B Marketing Teams',
      'Limited Offer — Ends Friday',
      'AI-Powered Workflows',
      'Every Draft Brand-Checked',
      'Brand Guardrails Built In',
      'Rated 4.8★ on G2',
    ],
    d: [
      'Every draft checked against your brand guardrails. Try free for 14 days — no card needed.',
      'Trusted by 1,200+ teams to create on-brand content with AI.',
      'Generate, review and publish from one platform. Boost output without extra headcount.',
      "Don't miss out — autumn pricing ends this week. Book your demo today.",
    ],
  },
}

function claimMultipliers(claims: Claim[], intent: Intent): [number, number] {
  let ctr = 1
  let cvr = 1
  for (const c of claims) {
    let [a, b] = TRUTH.claims[c]
    if (c === 'price' && intent === 'commercial') [a, b] = TRUTH.commercialPriceOverride
    if (intent === 'navigational') {
      a = a ** TRUTH.navigationalDamping
      b = b ** TRUTH.navigationalDamping
    }
    ctr *= a
    cvr *= b
  }
  return [ctr, cvr]
}

function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

function seasonal(iso: string): number {
  const d = weekday(iso)
  return d === 0 || d === 6 ? 0.6 : d === 1 ? 1.1 : 1.0
}

export interface SimulateOptions {
  seed?: number
  /** Turn the planted drift off, for the control test. */
  drift?: boolean
  /** Add the business behind the ads (services, enquiries, outcomes). On by default. */
  business?: boolean
  /** Which simulated account: the CY Group example (default) or another preset. */
  preset?: string
}

export const CY_ADS: AdAccountPreset = {
  id: 'cy-group',
  workspace: 'CY Group',
  brand: BRAND,
  site: SITE,
  keywords: KEYWORDS,
  adGroups: AD_GROUPS,
  terms: TERMS,
  organicOnly: ORGANIC_ONLY,
  pages: PAGES,
  auction: AUCTION,
  pinned: PINNED,
  assets: ASSETS,
  competitors: ['pipeloop', 'sendwise', 'funnelforge'],
  bannedTerms: ['guaranteed', 'best in the world', 'risk-free'],
}

export const PRESETS: Record<string, { ads: AdAccountPreset; business: BusinessPreset; label: string }> = {
  'cy-group': { ads: CY_ADS, business: CY_BUSINESS, label: 'CY Group (example SaaS account)' },
  'easy-liquidation': { ads: EL_ADS, business: EL_BUSINESS, label: 'Easy Liquidation' },
}

export function presetFor(id: string | undefined) {
  return PRESETS[id ?? 'cy-group'] ?? PRESETS['cy-group']!
}

export function simulate(opts: SimulateOptions = {}): SerpTwinInput {
  const preset = presetFor(opts.preset)
  const p = preset.ads
  const r = rng(opts.seed ?? 20260927)
  const withDrift = opts.drift ?? true
  const dates = Array.from({ length: DAYS }, (_, i) => shiftDate(END, -(DAYS - 1 - i)))
  const kwById = new Map(p.keywords.map(([id, ag, c]) => [id, { ag, c }]))
  const trueCtr = (p: number) => Math.min(0.9, TRUTH.ctrCurve.a * Math.max(1, p) ** -TRUTH.ctrCurve.b)

  const searchTerms: SearchTermRow[] = []
  const organic: OrganicRow[] = []
  const agImpr = new Map<string, number>()
  const agStats = new Map<string, { imp: number; clk: number; cnv: number }>()

  for (const [di, date] of dates.entries()) {
    const s = seasonal(date)
    const daysToEnd = DAYS - 1 - di
    for (const t of p.terms) {
      const k = kwById.get(t.kw)!
      let mult = 1
      if (t.drift) {
        if (!withDrift || daysToEnd >= TRUTH.driftStartsDaysBeforeEnd)
          mult = 0.03 // a trickle, as in real accounts
        else mult = 0.35 + 0.65 * (1 - daysToEnd / TRUTH.driftStartsDaysBeforeEnd)
      }
      const imp = poisson(t.imp * s * mult * (1 + 0.08 * gaussian(r)), r)
      if (imp > 0) {
        const clicks = binomial(imp, t.ctr, r)
        const conv = binomial(clicks, t.cvr, r)
        const cost = clicks * t.cpc * Math.max(0.6, 1 + 0.12 * gaussian(r))
        searchTerms.push({
          date,
          campaignId: k.c,
          adGroupId: k.ag,
          keywordId: t.kw,
          searchTerm: t.term,
          impressions: imp,
          clicks,
          costMicros: Math.round(cost * 1e6),
          conversions: conv,
          conversionValue: 0,
        })
        agImpr.set(k.ag, (agImpr.get(k.ag) ?? 0) + imp)
        const st = agStats.get(k.ag) ?? { imp: 0, clk: 0, cnv: 0 }
        st.imp += imp
        st.clk += clicks
        st.cnv += conv
        agStats.set(k.ag, st)
      }
      if (t.org !== null && t.page && t.orgImp)
        organic.push(organicRow(r, date, t.term, `${p.site}${t.page}`, t.orgImp * s, t.org, trueCtr))
    }
    for (const o of p.organicOnly)
      organic.push(organicRow(r, date, o.term, `${p.site}${o.page}`, o.orgImp * s, o.org, trueCtr))
  }

  // RSA assets — served in proportion to Google's own (noisy) view of their quality.
  const assets: AdAssetRow[] = []
  const brandIntent = (ag: string): Intent => {
    const terms = p.terms.filter((t) => kwById.get(t.kw)!.ag === ag)
    const votes = new Map<Intent, number>()
    for (const t of terms) {
      const i = classifyIntent(t.term, p.brand.terms, p.competitors).intent
      votes.set(i, (votes.get(i) ?? 0) + t.imp)
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  }
  for (const ag of p.adGroups) {
    const st = agStats.get(ag.adGroupId)
    if (!st || !p.assets[ag.adGroupId]) continue
    const intent = brandIntent(ag.adGroupId)
    const baseCtr = st.clk / st.imp
    const baseCvr = Math.max(0.005, st.cnv / Math.max(1, st.clk))
    for (const [field, list, perImpression] of [
      ['HEADLINE', p.assets[ag.adGroupId]!.h, 3],
      ['DESCRIPTION', p.assets[ag.adGroupId]!.d, 2],
    ] as const) {
      const specs = list.map((text, i) => {
        if (field === 'HEADLINE' && text.length > 30)
          throw new Error(`Simulator headline over 30 chars: ${text}`)
        if (field === 'DESCRIPTION' && text.length > 90)
          throw new Error(`Simulator description over 90 chars: ${text}`)
        const claims = extractClaims(text)
        const [cm, vm] = claimMultipliers(claims, intent)
        const serve = (cm * vm) ** 1.5 * Math.exp(0.35 * gaussian(r))
        return { text, i, cm, vm, serve }
      })
      const pinned = field === 'HEADLINE' ? (p.pinned[ag.adGroupId] ?? []) : []
      const served = (agImpr.get(ag.adGroupId) ?? 0) * ASSET_LIFETIME_FACTOR
      for (const x of specs) if (pinned.includes(x.i)) x.serve = 0
      const tot = specs.reduce((s2, x) => s2 + x.serve, 0)
      const pool = served * (perImpression - pinned.length)
      // Normalise so the ad group's mean multiplier is 1 — the base rates are the ad group's.
      const impOf = (x: (typeof specs)[number]) => (pinned.includes(x.i) ? served : (pool * x.serve) / tot)
      const totImp = specs.reduce((s2, x) => s2 + impOf(x), 0)
      const meanCm = specs.reduce((s2, x) => s2 + x.cm * impOf(x), 0) / totImp
      const meanVm = specs.reduce((s2, x) => s2 + x.vm * impOf(x), 0) / totImp
      for (const x of specs) {
        const imp = Math.round(impOf(x))
        const clk = binomial(imp, Math.min(0.95, baseCtr * (x.cm / meanCm)), r)
        const cnv = binomial(clk, Math.min(0.95, baseCvr * (x.vm / meanVm)), r)
        assets.push({
          adGroupId: ag.adGroupId,
          adId: `${ag.adGroupId}_rsa1`,
          assetId: `${ag.adGroupId}_${field[0]}${x.i + 1}`,
          field,
          text: x.text,
          impressions: imp,
          clicks: clk,
          conversions: cnv,
        })
      }
    }
  }

  const base: SerpTwinInput = {
    workspace: p.workspace,
    brand: p.brand,
    keywords: p.keywords.map(([keywordId, adGroupId, campaignId, text, matchType]): KeywordRow => ({
      keywordId,
      adGroupId,
      campaignId,
      text,
      matchType,
    })),
    adGroups: p.adGroups,
    searchTerms,
    assets,
    auction: p.auction,
    organic,
    pages: p.pages,
    bannedTerms: p.bannedTerms,
    dataNote: p.dataNote,
    simulated: true,
  }
  return opts.business === false ? base : addBusiness(base, opts.seed ?? 20260927, preset.business)
}

function organicRow(
  r: Rng,
  date: string,
  query: string,
  page: string,
  meanImp: number,
  pos: number,
  ctr: (p: number) => number,
): OrganicRow {
  const impressions = poisson(meanImp * (1 + 0.08 * gaussian(r)), r)
  // Position wobble grows with depth: a #1 brand result barely moves, a #9 result drifts.
  const position = Math.max(1, pos + 0.08 * pos * gaussian(r))
  return {
    date,
    query,
    page,
    impressions,
    clicks: binomial(impressions, ctr(position), r),
    position: Math.round(position * 10) / 10,
  }
}

/**
 * Runs a designed pause test against the planted truth: on "off" days the
 * paid clicks vanish and `TRUTH.recapture` of them reappear as organic
 * clicks. Returns what the platform would observe.
 */
export function simulatePauseTest(
  design: PauseTestDesign,
  opts: { seed?: number; recapture?: number } = {},
): PauseTestDay[] {
  const r = rng(opts.seed ?? 7)
  const rec = opts.recapture ?? TRUTH.recapture
  const start = shiftDate(END, 8)
  const { paidClicks, organicClicks, organicImpressions } = design.daily
  const ctrOrg = organicClicks / organicImpressions
  const paidPerImp = paidClicks / organicImpressions
  return design.schedule.map((arm, i) => {
    const date = shiftDate(start, i)
    // Demand swings day to day; paid and organic both follow it.
    const imp = poisson(organicImpressions * seasonal(date) * Math.max(0.5, 1 + 0.08 * gaussian(r)), r)
    const paid = binomial(imp, Math.min(0.95, paidPerImp), r)
    const org = binomial(imp, ctrOrg, r)
    if (arm === 'on') return { date, arm, paidClicks: paid, organicClicks: org, organicImpressions: imp }
    return { date, arm, paidClicks: 0, organicClicks: org + binomial(paid, rec, r), organicImpressions: imp }
  })
}
