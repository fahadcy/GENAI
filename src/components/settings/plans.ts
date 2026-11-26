import type { Workspace } from '@/lib/db/schema'

/**
 * Commercial model.
 *
 * There is no `src/lib/billing/plans.ts` in the codebase yet, so the tiers live
 * here next to the screen that renders them. If billing ever grows a server
 * module (Stripe price IDs, proration, invoices), this file is the thing to
 * move — the shapes below are deliberately free of UI concerns.
 *
 * Positioning: Aurea replaces a stack. A team running content generation,
 * scheduling, audience sync and a governance layer separately pays four
 * subscriptions and still has no single audit trail. That comparison is the
 * argument for the price, so the stack each tier absorbs is part of the tier.
 */

export type PlanId = 'trial' | 'studio' | 'growth' | 'scale' | 'enterprise'

export type PlanTier = {
  id: PlanId
  name: string
  /** Monthly list price in GBP. `null` means "priced per agreement". */
  price: number | null
  billing: 'per_seat' | 'flat' | 'custom'
  includedSeats: number
  /** Cost of each additional seat beyond the included allowance. */
  extraSeatPrice: number | null
  tagline: string
  bestFor: string
  limits: {
    /** AI-generated assets included each month. */
    assetsPerMonth: number | null
    contacts: number | null
    connectors: number | null
    approvalChains: number | null
    auditRetentionMonths: number | null
  }
  features: string[]
  /** Tools this tier makes redundant, with their published list price per month. */
  replaces: { category: string; typical: string; monthly: number }[]
}

export const PLANS: PlanTier[] = [
  {
    id: 'studio',
    name: 'Studio',
    price: 49,
    billing: 'per_seat',
    includedSeats: 1,
    extraSeatPrice: 49,
    tagline: 'For a small team that needs on-brand output fast.',
    bestFor: 'One to four marketers, owned channels only.',
    limits: {
      assetsPerMonth: 400,
      contacts: 10_000,
      connectors: 3,
      approvalChains: 2,
      auditRetentionMonths: 12,
    },
    features: [
      'Brief to scored variants across every owned channel',
      'Brand voice profile with live rule testing',
      'One-step approval chains',
      'Scheduler with send-time suggestions',
      'Hash-chained audit trail, 12 months retained',
    ],
    replaces: [
      { category: 'AI copywriting', typical: 'Jasper Creator', monthly: 39 },
      { category: 'Social scheduling', typical: 'Buffer Team', monthly: 48 },
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 790,
    billing: 'flat',
    includedSeats: 5,
    extraSeatPrice: 89,
    tagline: 'The governed loop, end to end, for a real marketing function.',
    bestFor: 'Five to fifteen people with legal or brand sign-off in the way.',
    limits: {
      assetsPerMonth: 2_500,
      contacts: 100_000,
      connectors: 8,
      approvalChains: 10,
      auditRetentionMonths: 36,
    },
    features: [
      'Everything in Studio',
      'Multi-step approval chains with SLAs and delegation',
      'Legal rule library with regex patterns per channel',
      'Audience targeting with consent and suppression enforced',
      'Paid and organic connectors, audience sync included',
      'Performance attribution tied back to spend',
      'CSV audit export for compliance review',
    ],
    replaces: [
      { category: 'AI content platform', typical: 'Jasper Business', monthly: 125 },
      { category: 'Social + scheduling', typical: 'Hootsuite Team', monthly: 249 },
      { category: 'Marketing automation', typical: 'HubSpot Marketing Pro', monthly: 792 },
      { category: 'Review and proofing', typical: 'Filestage Professional', monthly: 145 },
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    price: 1_900,
    billing: 'flat',
    includedSeats: 15,
    extraSeatPrice: 79,
    tagline: 'Multi-brand, multi-market, with the controls a CMO signs off.',
    bestFor: 'Fifteen or more people across several brands or regions.',
    limits: {
      assetsPerMonth: 12_000,
      contacts: 500_000,
      connectors: null,
      approvalChains: null,
      auditRetentionMonths: 84,
    },
    features: [
      'Everything in Growth',
      'Unlimited brand profiles and approval chains',
      'Per-brand and per-market legal rule sets',
      'Blackout windows and frequency caps enforced at publish',
      'Copilot recommendations with one-click revert',
      'SSO via SAML or OIDC, SCIM provisioning',
      'Seven-year audit retention',
    ],
    replaces: [
      { category: 'AI content platform', typical: 'Jasper Business', monthly: 125 },
      { category: 'Social + scheduling', typical: 'Sprout Social Advanced', monthly: 499 },
      { category: 'Marketing automation', typical: 'Marketo Growth', monthly: 1_795 },
      { category: 'Digital asset governance', typical: 'Frontify Pro', monthly: 690 },
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: null,
    billing: 'custom',
    includedSeats: 50,
    extraSeatPrice: null,
    tagline: 'Your residency, your retention, your paper.',
    bestFor: 'Regulated industries and anyone with a procurement process.',
    limits: {
      assetsPerMonth: null,
      contacts: null,
      connectors: null,
      approvalChains: null,
      auditRetentionMonths: null,
    },
    features: [
      'Everything in Scale',
      'Choice of data residency, including a dedicated tenant',
      'Custom retention and legal hold on the audit trail',
      'Private model deployment or bring-your-own key',
      'Named customer engineer and a 99.9% uptime SLA',
      'Security review, DPIA support and annual penetration test report',
    ],
    replaces: [
      { category: 'AI content platform', typical: 'Writer Enterprise', monthly: 1_500 },
      { category: 'Marketing automation', typical: 'Salesforce Marketing Cloud', monthly: 3_200 },
      { category: 'Governance and DAM', typical: 'Aprimo', monthly: 2_400 },
      { category: 'Compliance review', typical: 'Red Marker / Veriff', monthly: 900 },
    ],
  },
]

export const PLAN_BY_ID = new Map(PLANS.map((p) => [p.id, p]))

/** The trial is a state, not a tier — it maps onto Growth's capabilities. */
export const TRIAL_TIER: PlanTier = {
  ...PLANS[1],
  id: 'trial',
  name: 'Trial',
  price: 0,
  billing: 'flat',
  tagline: 'Full Growth capability while you evaluate.',
  bestFor: 'Fourteen days, no card, the whole product.',
}

export function tierFor(plan: string): PlanTier {
  if (plan === 'trial') return TRIAL_TIER
  return PLAN_BY_ID.get(plan as PlanId) ?? TRIAL_TIER
}

/** Monthly list price for a tier at a given seat count. */
export function monthlyPrice(tier: PlanTier, seats: number): number | null {
  if (tier.price === null) return null
  if (tier.billing === 'per_seat') return tier.price * Math.max(1, seats)
  const extra = Math.max(0, seats - tier.includedSeats)
  return tier.price + extra * (tier.extraSeatPrice ?? 0)
}

/**
 * The stack a tier retires, priced at that tier's included seat count. Seat-for-
 * seat comparison beyond the included allowance is not meaningful — the replaced
 * tools price on different units — so the comparison is always stated at the
 * included headcount and labelled as such.
 */
export function stackTotal(tier: PlanTier): number {
  return tier.replaces.reduce((a, r) => a + r.monthly, 0)
}

/** List price at the tier's own included headcount, for the stack comparison. */
export function basePrice(tier: PlanTier): number | null {
  return monthlyPrice(tier, tier.includedSeats)
}

/** Data-residency options offered on the workspace general screen. */
export const RESIDENCY: { value: Workspace['dataResidency']; label: string; detail: string }[] = [
  { value: 'eu', label: 'European Union', detail: 'Frankfurt (eu-central-1). GDPR primary region.' },
  { value: 'uk', label: 'United Kingdom', detail: 'London (eu-west-2). UK GDPR, data never leaves the UK.' },
  { value: 'us', label: 'United States', detail: 'Virginia (us-east-1). SCCs required for EU contacts.' },
]

export const TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Stockholm',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
]

export const CURRENCIES: { value: 'GBP' | 'EUR' | 'USD'; label: string }[] = [
  { value: 'GBP', label: 'Pound sterling (£)' },
  { value: 'EUR', label: 'Euro (€)' },
  { value: 'USD', label: 'US dollar ($)' },
]
