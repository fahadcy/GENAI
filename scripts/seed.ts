/**
 * Seeds a complete, believable workspace.
 *
 * This is not decorative sample data. It is built so that every downstream
 * feature has something real to compute against:
 *   - contacts carry consent, suppression and engagement hours, so segment
 *     sizing, reachability and send-time optimisation return real numbers;
 *   - 90 days of metric facts contain a genuinely fatiguing asset and a real
 *     cost-per-acquisition imbalance, so the copilot *finds* those rather than
 *     being handed them;
 *   - approvals include completed ones, so "average approval time" is measured.
 *
 * Run: npm run db:seed
 */
import '../src/lib/load-env'

import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'
import {
  adAccounts,
  adCampaigns,
  adPushLog,
  approvalChains,
  approvalDecisions,
  approvalRequests,
  assets,
  assetVersions,
  blackoutWindows,
  brandProfiles,
  briefs,
  campaigns,
  connectors,
  contacts,
  frequencyCaps,
  legalRules,
  memberships,
  metricFacts,
  notifications,
  planItems,
  scheduleItems,
  segments,
  subscriptions,
  users,
  workspaces,
  type AssetBody,
  type Channel,
} from '../src/lib/db/schema'
import { hashPassword } from '../src/lib/auth/password'
import { scoreAsset } from '../src/lib/ai/guardrails'
import { simulateVariants } from '../src/lib/ai/agents/content'
import { simulatePlan } from '../src/lib/ai/agents/planner'
import { simulateStructure } from '../src/lib/ai/agents/ads'
import { objectiveDef, toMicros } from '../src/lib/ads/objectives'
import { buildCampaignOperations } from '../src/lib/ads/google/build'
import { simulateMutate } from '../src/lib/ads/google/simulator'
import { readMutateResponse } from '../src/lib/ads/google/build'
import { recordAudit } from '../src/lib/workflow/audit'
import { refreshSegment } from '../src/lib/targeting/engine'
import { refreshRecommendations } from '../src/lib/copilot/analyze'
import * as budget from '../src/lib/budget/service'
import { decide as decideApproval, submitForReview } from '../src/lib/workflow/approvals'

/* ------------------------------------------------------ deterministic rng */

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20260821)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
const int = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min
const chance = (p: number) => rng() < p
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

const log = (msg: string) => console.log(`  ${msg}`)

/* ------------------------------------------------------------------ data */

const FIRST = ['Amara', 'Ben', 'Chloe', 'Daniel', 'Elena', 'Farid', 'Grace', 'Hassan', 'Isla', 'Jonas', 'Kiran', 'Lena', 'Marcus', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Samir', 'Tara', 'Umar', 'Vera', 'Will', 'Xenia', 'Yusuf', 'Zara', 'Aisha', 'Callum', 'Dev', 'Erin', 'Finn', 'Gita', 'Hugo', 'Ines', 'Jack', 'Kate', 'Leo', 'Mia', 'Noor', 'Owen']
const LAST = ['Adeyemi', 'Bianchi', 'Chen', 'Dubois', 'Eriksen', 'Fitzgerald', 'Garcia', 'Hoffmann', 'Iqbal', 'Jensen', 'Kowalski', 'Lindqvist', 'Mensah', 'Novak', 'Okafor', 'Patel', 'Quinn', 'Rossi', 'Silva', 'Tanaka', 'Ueda', 'Vasquez', 'Wright', 'Xu', 'Yilmaz', 'Zhang', 'Murphy', 'Kaur', 'Nguyen', 'Bakker']
const COMPANY_A = ['North', 'Bright', 'Clear', 'Iron', 'Blue', 'Meridian', 'Apex', 'Vertex', 'Harbour', 'Kite', 'Summit', 'Orbit', 'Ridge', 'Quay', 'Lantern', 'Anchor', 'Copper', 'Willow']
const COMPANY_B = ['Labs', 'Works', 'Group', 'Systems', 'Digital', 'Collective', 'Partners', 'Studio', 'Technologies', 'Retail', 'Health', 'Capital']
const TITLES = ['Head of Marketing', 'Marketing Manager', 'CMO', 'Growth Lead', 'Content Manager', 'Demand Generation Manager', 'Brand Director', 'Marketing Operations Manager', 'VP Marketing', 'Campaign Manager', 'Digital Marketing Lead', 'Product Marketing Manager']
const INDUSTRIES = ['SaaS', 'E-commerce', 'Financial services', 'Healthcare', 'Manufacturing', 'Professional services', 'Education', 'Media']
const COUNTRIES: [string, string, number][] = [
  ['GB', 'Europe/London', 0.34],
  ['US', 'America/New_York', 0.24],
  ['IE', 'Europe/Dublin', 0.07],
  ['DE', 'Europe/Berlin', 0.09],
  ['FR', 'Europe/Paris', 0.06],
  ['NL', 'Europe/Amsterdam', 0.05],
  ['ES', 'Europe/Madrid', 0.04],
  ['CA', 'America/Toronto', 0.05],
  ['AU', 'Australia/Sydney', 0.04],
  ['AE', 'Asia/Dubai', 0.02],
]
/**
 * The approval outcome cycle applied to organic assets, in order. Chosen so the
 * seeded workspace shows every state a reviewer will encounter: a working queue,
 * a rejection with a real comment, and untouched drafts.
 */
const ORGANIC_OUTCOMES = [
  'approved',
  'pending',
  'approved',
  'draft',
  'approved',
  'rejected',
  'pending',
  'approved',
  'draft',
  'pending',
] as const

const STAGES = ['subscriber', 'lead', 'lead', 'mql', 'mql', 'sql', 'opportunity', 'customer', 'customer', 'churned']

function weightedCountry(): [string, string] {
  let r = rng()
  for (const [code, tz, w] of COUNTRIES) {
    r -= w
    if (r <= 0) return [code, tz]
  }
  return ['GB', 'Europe/London']
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log('\n▸ Seeding Aurea\n')

  log('Clearing existing data…')
  await db.execute(sql`
    truncate table
      "audit_events","ai_runs","ai_cache","notifications","usage_counters","subscriptions",
      "metric_facts","recommendations","schedule_items","blackout_windows","frequency_caps",
      "approval_decisions","approval_requests","approval_chains",
      "asset_versions","assets","briefs","plan_items","campaign_templates","campaigns",
      "segment_members","segments","contacts","legal_rules","brand_profiles",
      "ad_push_log","ad_campaigns","ad_accounts",
      "connectors","invitations","sessions","memberships","users","workspaces"
    restart identity cascade
  `)

  /* ------------------------------------------------------------ workspace */

  const [ws] = await db
    .insert(workspaces)
    .values({
      name: 'CY Group',
      slug: 'cy-group',
      plan: 'growth',
      seats: 12,
      dataResidency: 'eu',
      settings: {
        defaultTimezone: 'Europe/London',
        weekStartsOn: 1,
        currency: 'GBP',
        requireApprovalAboveSpend: 2500,
      },
    })
    .returning()
  log(`Workspace: ${ws.name}`)

  await db.insert(subscriptions).values({
    workspaceId: ws.id,
    plan: 'growth',
    status: 'active',
    seats: 12,
    currentPeriodEnd: new Date(Date.now() + 22 * 86_400_000),
  })

  /* ---------------------------------------------------------------- users */

  const password = await hashPassword('Aurea2026!')
  const people = [
    { name: 'Fahad Ali', email: 'fahad.ali@currieyoung.com', role: 'owner' as const, jobTitle: 'Head of Marketing', hue: 258 },
    { name: 'Priya Raman', email: 'priya@currieyoung.com', role: 'strategist' as const, jobTitle: 'Growth Marketing Lead', hue: 172 },
    { name: 'Marcus Webb', email: 'marcus@currieyoung.com', role: 'creator' as const, jobTitle: 'Senior Content Designer', hue: 32 },
    { name: 'Elena Rossi', email: 'elena@currieyoung.com', role: 'approver' as const, jobTitle: 'Legal Counsel', hue: 348 },
    { name: 'Daniel Okafor', email: 'daniel@currieyoung.com', role: 'admin' as const, jobTitle: 'Marketing Operations', hue: 210 },
    { name: 'Grace Lindqvist', email: 'grace@currieyoung.com', role: 'analyst' as const, jobTitle: 'Marketing Analyst', hue: 128 },
  ]

  const inserted = await db
    .insert(users)
    .values(
      people.map((p) => ({
        email: p.email,
        name: p.name,
        passwordHash: password,
        jobTitle: p.jobTitle,
        avatarHue: p.hue,
        lastLoginAt: daysAgo(rng()),
      })),
    )
    .returning()

  const U = Object.fromEntries(inserted.map((u) => [u.email, u]))
  await db.insert(memberships).values(
    people.map((p) => ({ workspaceId: ws.id, userId: U[p.email].id, role: p.role })),
  )
  const owner = U['fahad.ali@currieyoung.com']
  const strategist = U['priya@currieyoung.com']
  const creator = U['marcus@currieyoung.com']
  const legal = U['elena@currieyoung.com']
  const ops = U['daniel@currieyoung.com']
  log(`Users: ${people.length} across all six roles`)

  /* ------------------------------------------------------- brand + legal */

  const [brand] = await db
    .insert(brandProfiles)
    .values({
      workspaceId: ws.id,
      name: 'CY Group — core voice',
      isDefault: true,
      voice:
        'Direct, credible and unhurried. We sound like an experienced practitioner explaining something clearly to a peer — never like a vendor performing enthusiasm. Concrete over abstract. Specific numbers over adjectives. We respect the reader\'s time.',
      tone: { formal: 58, playful: 24, technical: 52, urgent: 28, warm: 55 },
      doList: [
        'Lead with the concrete problem the reader recognises',
        'Use specific figures where we have them',
        'Write short sentences and short paragraphs',
        'Name the trade-off honestly',
      ],
      dontList: [
        'Open with "In today\'s fast-paced world"',
        'Use hype words like revolutionary, game-changing or unlock',
        'Make performance claims we cannot evidence',
        'Stack more than one exclamation mark',
      ],
      bannedTerms: ['guaranteed', 'revolutionary', 'game-changing', 'best-in-class', 'synergy', 'disrupt', 'unlock', 'skyrocket'],
      preferredTerms: [
        { avoid: 'leverage', use: 'use' },
        { avoid: 'utilise', use: 'use' },
        { avoid: 'solution', use: 'product' },
        { avoid: 'reach out', use: 'get in touch' },
      ],
      requiredDisclaimers: [
        {
          text: 'Results shown are from a pilot programme and are not a prediction of your results.',
          channels: ['google_ads', 'meta_ads'],
        },
      ],
      readingLevelMax: 11,
      maxExclamations: 1,
      colors: { primary: '#5B4BE0', secondary: '#0E1116', accent: '#E8B341' },
      passThreshold: 80,
    })
    .returning()

  await db.insert(legalRules).values([
    {
      workspaceId: ws.id,
      name: 'Unqualified guarantee',
      pattern: '\\b(guarantee[sd]?|guaranteed results|risk[- ]free|100% (?:certain|sure))\\b',
      severity: 'high',
      message: 'Absolute guarantees create a contractual claim we cannot support.',
      remedy: 'Replace with a qualified statement, e.g. "in our pilot, teams saw…".',
      channels: [],
    },
    {
      workspaceId: ws.id,
      name: 'Unsubstantiated superlative',
      pattern: "\\b(the )?(best|fastest|cheapest|number one|#1|leading|most advanced) (platform|tool|product|software)\\b",
      severity: 'medium',
      message: 'Comparative superlatives need substantiation on file before publication.',
      remedy: 'Cite the source, or soften to a specific, provable claim.',
      channels: [],
    },
    {
      workspaceId: ws.id,
      name: 'Named competitor comparison',
      pattern: '\\b(HubSpot|Marketo|Salesforce|Jasper|Hootsuite|Buffer|Copy\\.ai)\\b',
      severity: 'medium',
      message: 'Naming a competitor in paid or social copy requires legal sign-off.',
      remedy: 'Remove the name or route through the paid-media approval chain.',
      channels: ['google_ads', 'meta_ads', 'linkedin', 'x', 'facebook', 'instagram'],
    },
    {
      workspaceId: ws.id,
      name: 'Financial return claim',
      pattern: '\\b(ROI of|return on investment of|save \\$?£?\\d+|\\d+x (?:return|revenue))\\b',
      severity: 'high',
      message: 'Specific financial return claims require documented evidence and legal approval.',
      remedy: 'Attach the evidence, or restate as a range observed in a named pilot.',
      channels: [],
    },
    {
      workspaceId: ws.id,
      name: 'Missing unsubscribe context',
      pattern: '\\b(you have been added|we added you|subscribed you)\\b',
      severity: 'high',
      message: 'Implies non-consensual list addition, which is a GDPR problem.',
      remedy: 'Reference how the contact opted in.',
      channels: ['email', 'sms'],
    },
    {
      workspaceId: ws.id,
      name: 'Health or medical claim',
      pattern: '\\b(cure[sd]?|treat[s]? (?:anxiety|depression)|clinically proven)\\b',
      severity: 'high',
      message: 'Health claims are regulated and cannot appear in marketing copy.',
      remedy: 'Remove the claim entirely.',
      channels: [],
    },
  ])
  log('Brand profile + 6 legal rules')

  /* ------------------------------------------------------ approval chains */

  const [standardChain, paidChain, highSpendChain] = await db
    .insert(approvalChains)
    .values([
      {
        workspaceId: ws.id,
        name: 'Standard content',
        description: 'Owned channels: one marketing review before scheduling.',
        scope: { channels: ['email', 'linkedin', 'blog', 'web', 'x', 'sms', 'push'] },
        steps: [{ name: 'Marketing review', role: 'approver', mode: 'any', slaHours: 8 }],
        isDefault: true,
        priority: 0,
      },
      {
        workspaceId: ws.id,
        name: 'Paid media',
        description: 'Anything with spend behind it goes through legal, then ops.',
        scope: { channels: ['google_ads', 'meta_ads', 'facebook', 'instagram'] },
        steps: [
          { name: 'Legal review', role: 'approver', mode: 'any', slaHours: 12 },
          { name: 'Ops sign-off', role: 'admin', mode: 'any', slaHours: 6 },
        ],
        isDefault: false,
        priority: 10,
      },
      {
        workspaceId: ws.id,
        name: 'High spend (over £2,500)',
        description: 'Adds an owner approval on top of legal and ops.',
        scope: { spendThreshold: 2500 },
        steps: [
          { name: 'Legal review', role: 'approver', mode: 'any', slaHours: 12 },
          { name: 'Ops sign-off', role: 'admin', mode: 'any', slaHours: 6 },
          { name: 'Budget owner', role: 'owner', mode: 'any', slaHours: 24 },
        ],
        isDefault: false,
        priority: 20,
      },
    ])
    .returning()
  log('Approval chains: standard, paid media, high spend')

  /* ---------------------------------------------------------- connectors */

  await db.insert(connectors).values([
    { workspaceId: ws.id, provider: 'hubspot_crm', category: 'crm', displayName: 'HubSpot CRM', status: 'connected', lastSyncAt: new Date(Date.now() - 42 * 60000), scopes: ['contacts.read', 'contacts.write'] },
    { workspaceId: ws.id, provider: 'sendgrid', category: 'esp', displayName: 'SendGrid', status: 'connected', lastSyncAt: new Date(Date.now() - 9 * 60000), scopes: ['mail.send', 'suppressions.read'] },
    { workspaceId: ws.id, provider: 'linkedin_pages', category: 'social', displayName: 'LinkedIn Pages', status: 'connected', lastSyncAt: new Date(Date.now() - 130 * 60000), scopes: ['w_organization_social'] },
    { workspaceId: ws.id, provider: 'google_ads', category: 'ads', displayName: 'Google Ads', status: 'connected', lastSyncAt: new Date(Date.now() - 26 * 60000), scopes: ['adwords'] },
    { workspaceId: ws.id, provider: 'ga4', category: 'analytics', displayName: 'Google Analytics 4', status: 'degraded', lastSyncAt: new Date(Date.now() - 19 * 3600000), lastError: 'Property 284119203: quota exceeded on the last two syncs.', scopes: ['analytics.readonly'] },
    { workspaceId: ws.id, provider: 'meta_ads', category: 'ads', displayName: 'Meta Ads', status: 'disconnected', scopes: [] },
    { workspaceId: ws.id, provider: 'salesforce', category: 'crm', displayName: 'Salesforce', status: 'disconnected', scopes: [] },
    { workspaceId: ws.id, provider: 'clicksend', category: 'esp', displayName: 'ClickSend', status: 'disconnected', scopes: [] },
    { workspaceId: ws.id, provider: 'wordpress', category: 'esp', displayName: 'WordPress', status: 'disconnected', scopes: [] },
  ])
  log('Connectors: 4 connected, 1 degraded, 3 available')

  /* ------------------------------------------------------------ contacts */

  const CONTACT_COUNT = 1400
  const contactRows: (typeof contacts.$inferInsert)[] = []
  const usedEmails = new Set<string>()

  for (let i = 0; i < CONTACT_COUNT; i++) {
    const first = pick(FIRST)
    const last = pick(LAST)
    const company = `${pick(COMPANY_A)} ${pick(COMPANY_B)}`
    const domain = company.toLowerCase().replace(/\s+/g, '') + '.com'
    let email = `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`
    if (usedEmails.has(email)) email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@${domain}`
    usedEmails.add(email)

    const [country, timezone] = weightedCountry()
    const stage = pick(STAGES)
    const isCustomer = stage === 'customer'
    const suppressed = chance(0.055)

    // Engagement is bimodal: an active core and a long dormant tail. That shape
    // is what makes send-time optimisation and re-engagement segments meaningful.
    const engaged = chance(0.42)
    const engagementScore = engaged ? int(52, 97) : int(1, 44)

    // Engagement hour clusters around the working day with a small evening bump.
    const hour = chance(0.72) ? int(8, 17) : chance(0.6) ? int(18, 21) : int(5, 7)

    const consentBase = !suppressed && chance(0.88)
    contactRows.push({
      workspaceId: ws.id,
      externalId: `hs_${100000 + i}`,
      email,
      name: `${first} ${last}`,
      company,
      jobTitle: pick(TITLES),
      country,
      timezone,
      industry: pick(INDUSTRIES),
      employees: pick([12, 28, 45, 60, 85, 120, 180, 260, 400, 650, 900, 1400, 2200, 4000]),
      lifecycleStage: stage,
      plan: isCustomer ? pick(['starter', 'growth', 'growth', 'enterprise']) : chance(0.18) ? 'trial' : 'none',
      mrr: isCustomer ? String(pick([180, 340, 490, 760, 1200, 2400])) : null,
      lastActivityAt: engaged ? daysAgo(rng() * 21) : daysAgo(21 + rng() * 160),
      signupAt: daysAgo(30 + rng() * 700),
      consent: {
        email: consentBase,
        sms: consentBase && chance(0.34),
        push: consentBase && chance(0.22),
        ads: consentBase && chance(0.71),
        capturedAt: daysAgo(30 + rng() * 500).toISOString(),
        basis: chance(0.8) ? 'consent' : 'legitimate_interest',
      },
      suppressed,
      suppressionReason: suppressed ? pick(['Unsubscribed', 'Hard bounce', 'Spam complaint', 'Right to erasure request']) : null,
      engagementHour: hour,
      engagementScore,
      attributes: {},
    })
  }

  for (let i = 0; i < contactRows.length; i += 500) {
    await db.insert(contacts).values(contactRows.slice(i, i + 500))
  }
  const suppressedCount = contactRows.filter((c) => c.suppressed).length
  log(`Contacts: ${CONTACT_COUNT} (${suppressedCount} suppressed, consent recorded on all)`)

  /* ------------------------------------------------------------- segments */

  const segmentDefs = [
    {
      name: 'Engaged UK mid-market',
      description: 'The core ICP: engaged contacts at UK companies large enough to have a marketing team.',
      nlQuery: 'UK companies with more than 100 employees who have been active in the last 30 days and are highly engaged',
      rules: {
        combinator: 'and' as const,
        rules: [
          { field: 'country', op: 'eq' as const, value: 'GB', label: 'Country is GB' },
          { field: 'employees', op: 'gt' as const, value: 100, label: 'More than 100 employees' },
          { field: 'lastActivityAt', op: 'within_days' as const, value: 30, label: 'Active in the last 30 days' },
          { field: 'engagementScore', op: 'gte' as const, value: 50, label: 'Engagement score ≥ 50' },
        ],
      },
      syncTargets: ['email', 'linkedin', 'google_ads'],
    },
    {
      name: 'Trial users, no conversion',
      description: 'On a trial plan and still in a pre-customer lifecycle stage.',
      nlQuery: 'people on the trial plan who are still leads or MQLs',
      rules: {
        combinator: 'and' as const,
        rules: [
          { field: 'plan', op: 'eq' as const, value: 'trial', label: 'Plan is trial' },
          { field: 'lifecycleStage', op: 'in' as const, value: ['lead', 'mql', 'sql'], label: 'Stage is lead, MQL or SQL' },
        ],
      },
      syncTargets: ['email', 'google_ads'],
    },
    {
      name: 'Dormant — 60 day re-engagement',
      description: 'Low engagement and no recent activity. Deliberately excluded from paid.',
      nlQuery: 'contacts who have gone quiet with low engagement',
      rules: {
        combinator: 'and' as const,
        rules: [
          { field: 'engagementScore', op: 'lt' as const, value: 30, label: 'Engagement score < 30' },
          { field: 'lifecycleStage', op: 'nin' as const, value: ['churned'], label: 'Stage is not churned' },
        ],
      },
      syncTargets: ['email'],
    },
    {
      name: 'SaaS decision makers',
      description: 'Senior marketing titles at SaaS companies — the highest-converting slice.',
      nlQuery: 'heads of marketing at SaaS companies',
      rules: {
        combinator: 'and' as const,
        rules: [
          { field: 'industry', op: 'eq' as const, value: 'SaaS', label: 'Industry is SaaS' },
          { field: 'jobTitle', op: 'contains' as const, value: 'Head of', label: 'Job title contains "Head of"' },
        ],
      },
      syncTargets: ['email', 'linkedin'],
    },
  ]

  const segmentRows = await db
    .insert(segments)
    .values(
      segmentDefs.map((s) => ({
        workspaceId: ws.id,
        name: s.name,
        description: s.description,
        nlQuery: s.nlQuery,
        rules: s.rules,
        sourceType: 'rule',
        syncTargets: s.syncTargets,
        createdBy: strategist.id,
      })),
    )
    .returning()

  for (const s of segmentRows) {
    const r = await refreshSegment(ws.id, s.id)
    log(`Segment "${s.name}": ${r.matched} matched, ${r.reachable} reachable, ${r.suppressed} suppressed`)
  }
  const [coreSeg, trialSeg, dormantSeg, saasSeg] = segmentRows

  /* ------------------------------------------------------- scheduling ops */

  await db.insert(frequencyCaps).values([
    { workspaceId: ws.id, channel: 'email', maxPerContact: 3, windowDays: 7 },
    { workspaceId: ws.id, channel: 'sms', maxPerContact: 1, windowDays: 14 },
    { workspaceId: ws.id, channel: 'push', maxPerContact: 4, windowDays: 7 },
  ])

  await db.insert(blackoutWindows).values([
    {
      workspaceId: ws.id,
      name: 'Christmas shutdown',
      startsAt: new Date('2026-12-23T00:00:00Z'),
      endsAt: new Date('2027-01-02T09:00:00Z'),
      channels: [],
      reason: 'No outbound while the office is closed.',
    },
    {
      workspaceId: ws.id,
      name: 'Results week — paid pause',
      startsAt: new Date(Date.now() + 12 * 86_400_000),
      endsAt: new Date(Date.now() + 15 * 86_400_000),
      channels: ['google_ads', 'meta_ads'],
      reason: 'Paid paused during the quarterly results announcement.',
    },
  ])

  /* ------------------------------------------------------------ campaigns */

  const campaignDefs = [
    {
      name: 'Q3 Platform Launch',
      objective: 'Drive 400 qualified signups for the unified workspace launch',
      goalMetric: 'signups',
      targetValue: 400,
      budget: '28000',
      status: 'active' as const,
      startOffset: -34,
      durationDays: 56,
      channels: ['email', 'linkedin', 'google_ads', 'blog'] as Channel[],
      owner: strategist.id,
    },
    {
      name: 'Trial-to-paid activation',
      objective: 'Convert trialists into paying customers before day 14',
      goalMetric: 'conversions',
      targetValue: 120,
      budget: '9000',
      status: 'active' as const,
      startOffset: -21,
      durationDays: 42,
      channels: ['email', 'push'] as Channel[],
      owner: owner.id,
    },
    {
      name: 'Autumn re-engagement',
      objective: 'Win back dormant contacts with a genuinely useful piece of research',
      goalMetric: 'opens',
      targetValue: 3000,
      budget: '4500',
      status: 'planning' as const,
      startOffset: 6,
      durationDays: 30,
      channels: ['email', 'linkedin'] as Channel[],
      owner: strategist.id,
    },
  ]

  const campaignRows = await db
    .insert(campaigns)
    .values(
      campaignDefs.map((c) => ({
        workspaceId: ws.id,
        name: c.name,
        objective: c.objective,
        goalMetric: c.goalMetric,
        targetValue: c.targetValue,
        budget: c.budget,
        status: c.status,
        startDate: isoDay(daysAgo(-c.startOffset)),
        endDate: isoDay(daysAgo(-c.startOffset - c.durationDays)),
        ownerId: c.owner,
        channels: c.channels,
        createdAt: daysAgo(Math.abs(c.startOffset) + 6),
      })),
    )
    .returning()

  const roleToUser: Record<string, string> = {
    strategist: strategist.id,
    creator: creator.id,
    approver: legal.id,
    admin: ops.id,
    analyst: U['grace@currieyoung.com'].id,
    owner: owner.id,
  }

  for (let ci = 0; ci < campaignRows.length; ci++) {
    const campaign = campaignRows[ci]
    const def = campaignDefs[ci]
    const plan = simulatePlan({
      campaignId: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      channels: def.channels,
      durationDays: def.durationDays,
    })

    const start = new Date(daysAgo(-def.startOffset))
    const refToId = new Map<string, string>()

    for (let ti = 0; ti < plan.tasks.length; ti++) {
      const task = plan.tasks[ti]
      const startDate = new Date(start.getTime() + task.startOffsetDays * 86_400_000)
      const dueDate = new Date(startDate.getTime() + task.durationDays * 86_400_000)
      const elapsed = Date.now() - startDate.getTime()
      const status =
        campaign.status === 'planning'
          ? 'not_started'
          : dueDate.getTime() < Date.now()
            ? 'done'
            : elapsed > 0
              ? chance(0.6) ? 'in_progress' : 'in_review'
              : 'not_started'

      const [row] = await db
        .insert(planItems)
        .values({
          workspaceId: ws.id,
          campaignId: campaign.id,
          phase: task.phase,
          title: task.title,
          description: task.description,
          channel: (task.channel as Channel) ?? null,
          ownerId: roleToUser[task.ownerRole] ?? strategist.id,
          startDate: isoDay(startDate),
          dueDate: isoDay(dueDate),
          dependsOn: task.dependsOn.map((r) => refToId.get(r)).filter(Boolean) as string[],
          status,
          segmentId: ti === 1 ? coreSeg.id : null,
          approvalChainId: task.needsApproval ? standardChain.id : null,
          isMilestone: task.isMilestone,
          atRisk: status !== 'done' && dueDate.getTime() < Date.now() + 3 * 86_400_000 && elapsed > 0,
          sortIndex: ti,
        })
        .returning({ id: planItems.id })
      refToId.set(task.ref, row.id)
    }

    await recordAudit({
      workspaceId: ws.id,
      actorId: def.owner,
      action: 'campaign.created',
      subjectType: 'campaign',
      subjectId: campaign.id,
      summary: `Campaign "${campaign.name}" created with a ${plan.tasks.length}-task plan across ${plan.phases.length} phases.`,
      payload: { objective: campaign.objective, channels: def.channels },
    })
  }
  log(`Campaigns: ${campaignRows.length} with generated plans`)

  const [launchCampaign, activationCampaign, reengageCampaign] = campaignRows

  /* -------------------------------------------------------------- content */

  const briefDefs = [
    {
      campaign: launchCampaign,
      title: 'Launch announcement — one governed pipeline',
      objective: 'Announce the unified workspace and drive demo signups from marketing leaders',
      audienceNote: 'Heads of marketing at UK and US companies of 100-2,000 people who currently run three or four overlapping tools',
      keyMessages: [
        'the work is slow because the steps do not talk to each other, not because any step is hard',
        'generation and decisioning run in one loop, so what you learn feeds the next campaign',
        'every asset is scored against brand and legal rules before a human sees it',
      ],
      channels: ['email', 'linkedin', 'blog'],
      cta: 'See a 12-minute walkthrough',
      mustInclude: [],
      variants: 2,
      author: creator.id,
    },
    {
      campaign: launchCampaign,
      title: 'Paid acquisition — approval time angle',
      objective: 'Acquire demo requests from marketers frustrated by approval delays',
      audienceNote: 'Marketing managers who have said approvals are their bottleneck',
      keyMessages: [
        'approvals sitting in inboxes are the single biggest drag on campaign turnaround',
        'a governed pipeline cuts average approval time by roughly a third',
      ],
      channels: ['google_ads', 'meta_ads'],
      cta: 'Book a walkthrough',
      mustInclude: [],
      variants: 2,
      author: creator.id,
    },
    {
      campaign: activationCampaign,
      title: 'Trial day 3 — first campaign nudge',
      objective: 'Get trialists to publish their first governed campaign inside the trial window',
      audienceNote: 'People who started a trial and have generated content but never scheduled anything',
      keyMessages: [
        'the fastest way to see the value is to take one real brief all the way to published',
        'the first campaign takes about twenty minutes end to end',
      ],
      channels: ['email', 'push'],
      cta: 'Publish your first campaign',
      mustInclude: [],
      variants: 2,
      author: creator.id,
    },
    {
      campaign: reengageCampaign,
      title: 'Re-engagement — the handoff research',
      objective: 'Win back dormant contacts by leading with genuinely useful research rather than a pitch',
      audienceNote: 'Contacts who have not engaged in 60+ days',
      keyMessages: [
        'we measured where marketing time actually goes and the answer was the gaps between tools',
        'the report is free and requires no signup',
      ],
      channels: ['email', 'linkedin'],
      cta: 'Read the report',
      mustInclude: [],
      variants: 2,
      author: creator.id,
    },
  ]

  const legalRuleRows = await db.select().from(legalRules).where(sql`workspace_id = ${ws.id}`)

  const allAssets: { id: string; channel: Channel; campaignId: string; briefId: string; composite: number; title: string }[] = []

  for (const bd of briefDefs) {
    const [brief] = await db
      .insert(briefs)
      .values({
        workspaceId: ws.id,
        campaignId: bd.campaign.id,
        title: bd.title,
        objective: bd.objective,
        audienceNote: bd.audienceNote,
        keyMessages: bd.keyMessages,
        channels: bd.channels,
        callToAction: bd.cta,
        mustInclude: bd.mustInclude,
        mustAvoid: [],
        brandProfileId: brand.id,
        variantsPerChannel: bd.variants,
        createdBy: bd.author,
        createdAt: daysAgo(int(8, 30)),
      })
      .returning()

    const variants = simulateVariants(brief, brand, bd.channels, bd.variants)

    for (const v of variants) {
      const detail = scoreAsset({
        body: v.body,
        channel: v.channel,
        profile: brand,
        legalRules: legalRuleRows,
      })
      const createdAt = daysAgo(int(4, 26))
      const [asset] = await db
        .insert(assets)
        .values({
          workspaceId: ws.id,
          briefId: brief.id,
          campaignId: bd.campaign.id,
          channel: v.channel as Channel,
          variantLabel: v.variantLabel,
          title: v.title,
          body: v.body as AssetBody,
          imagePrompt: v.imagePrompt,
          status: 'draft',
          stage: 'generate',
          brandScore: detail.brand.score,
          complianceScore: detail.compliance.score,
          compositeScore: detail.composite,
          scoreDetail: detail,
          createdBy: bd.author,
          createdAt,
          updatedAt: createdAt,
        })
        .returning()

      await db.insert(assetVersions).values({
        assetId: asset.id,
        version: 1,
        body: v.body as AssetBody,
        scoreDetail: detail,
        note: 'Initial generation from the brief.',
        createdBy: bd.author,
        createdAt,
      })

      await recordAudit({
        workspaceId: ws.id,
        actorId: bd.author,
        actorType: 'system',
        action: 'asset.generated',
        subjectType: 'asset',
        subjectId: asset.id,
        summary: `Generated "${v.title}" (${v.channel}, variant ${v.variantLabel}) from brief "${brief.title}". Scored ${detail.composite}/100.`,
        payload: { briefId: brief.id, channel: v.channel, composite: detail.composite, passed: detail.passed },
      })

      allAssets.push({
        id: asset.id,
        channel: v.channel as Channel,
        campaignId: bd.campaign.id,
        briefId: brief.id,
        composite: detail.composite,
        title: v.title,
      })

      // Attach the asset to the plan task that produces this channel's
      // creative, so the planner shows a real link rather than an empty slot.
      const [task] = await db
        .select({ id: planItems.id })
        .from(planItems)
        .where(
          sql`campaign_id = ${bd.campaign.id} and channel = ${v.channel}::channel and phase = 'Creative'`,
        )
        .limit(1)
      if (task) {
        await db.update(assets).set({ planItemId: task.id }).where(sql`id = ${asset.id}`)
      }
    }
  }
  log(`Content: ${briefDefs.length} briefs → ${allAssets.length} scored assets`)

  /* ----------------------------------------------------------- approvals */

  // Walk a realistic mix: most fully approved (with measured resolution times),
  // a few pending, one overdue, one rejected.
  let approvedCount = 0
  let pendingCount = 0
  // Counted separately from the loop index: paid assets always approve, so
  // keying the outcome mix off `i` would leave the review queue nearly empty.
  let organicIndex = 0

  for (let i = 0; i < allAssets.length; i++) {
    const a = allAssets[i]
    const isPaid = ['google_ads', 'meta_ads', 'facebook', 'instagram'].includes(a.channel)
    const chain = isPaid ? paidChain : standardChain

    // Paid assets always go live: the copilot's budget detector needs real
    // spend and conversions on more than one paid channel before it has
    // anything to compare, and a demo where that finding never appears hides
    // one of the five detectors.
    //
    // Organic assets follow an explicit cycle rather than modular arithmetic on
    // the loop index, because the demo needs a specific mix on screen — a
    // working review queue, one rejection with a real comment, a couple of
    // untouched drafts — and that is easier to read and to change as a list.
    const organic = isPaid ? -1 : organicIndex++
    const outcome = isPaid ? 'approved' : ORGANIC_OUTCOMES[organic % ORGANIC_OUTCOMES.length]
    if (outcome === 'draft') continue
    const isOverdue = organic === 1
    // Pending work is measured in hours, not days: an SLA is 8-12 hours, so a
    // queue where everything is a day old would be a queue where everything is
    // overdue — which is a seeding artefact, not a realistic bottleneck. One
    // item is deliberately pushed past its SLA so the escalation path is
    // visible without drowning the copilot in identical findings.
    const requestedAt =
      outcome === 'pending'
        ? new Date(Date.now() - (isOverdue ? 26 : 1 + rng() * 4) * 3_600_000)
        : daysAgo(int(3, 22))

    const [req] = await db
      .insert(approvalRequests)
      .values({
        workspaceId: ws.id,
        subjectType: 'asset',
        subjectId: a.id,
        chainId: chain.id,
        currentStep: 0,
        status: 'pending',
        subjectVersion: 1,
        requestedBy: creator.id,
        requestedAt,
        dueAt: isOverdue
          ? new Date(Date.now() - 14 * 3_600_000)
          : new Date(requestedAt.getTime() + chain.steps[0].slaHours * 3_600_000),
      })
      .returning()

    await db.update(assets).set({ status: 'in_review', stage: 'review' }).where(sql`id = ${a.id}`)
    await recordAudit({
      workspaceId: ws.id,
      actorId: creator.id,
      action: 'approval.requested',
      subjectType: 'asset',
      subjectId: a.id,
      summary: `"${a.title}" submitted to "${chain.name}" — step 1 of ${chain.steps.length}.`,
      payload: { chainId: chain.id, requestId: req.id },
    })

    if (outcome === 'pending') {
      pendingCount++
      continue
    }

    if (outcome === 'rejected') {
      const decidedAt = new Date(requestedAt.getTime() + int(2, 9) * 3_600_000)
      await db.insert(approvalDecisions).values({
        requestId: req.id,
        step: 0,
        userId: legal.id,
        decision: 'reject',
        comment: 'The second paragraph implies a performance guarantee. Please restate it as a range observed in the pilot, with the pilot named.',
        createdAt: decidedAt,
      })
      await db
        .update(approvalRequests)
        .set({
          status: 'rejected',
          completedAt: decidedAt,
          resolutionMs: decidedAt.getTime() - requestedAt.getTime(),
        })
        .where(sql`id = ${req.id}`)
      await db.update(assets).set({ status: 'changes_requested', stage: 'generate' }).where(sql`id = ${a.id}`)
      await recordAudit({
        workspaceId: ws.id,
        actorId: legal.id,
        action: 'approval.rejected',
        subjectType: 'asset',
        subjectId: a.id,
        summary: 'Changes requested at step 1 (Legal review): implied performance guarantee.',
        payload: { requestId: req.id },
      })
      continue
    }

    // Approve through every step.
    let cursor = requestedAt
    for (let step = 0; step < chain.steps.length; step++) {
      const approver = chain.steps[step].role === 'admin' ? ops : chain.steps[step].role === 'owner' ? owner : legal
      cursor = new Date(cursor.getTime() + int(1, 7) * 3_600_000)
      await db.insert(approvalDecisions).values({
        requestId: req.id,
        step,
        userId: approver.id,
        decision: 'approve',
        comment: step === 0 ? 'Reads well and the claims are supportable. Approved.' : 'Budget and targeting check out.',
        createdAt: cursor,
      })
    }
    await db
      .update(approvalRequests)
      .set({
        status: 'approved',
        currentStep: chain.steps.length - 1,
        completedAt: cursor,
        resolutionMs: cursor.getTime() - requestedAt.getTime(),
      })
      .where(sql`id = ${req.id}`)
    await db.update(assets).set({ status: 'approved', stage: 'approve' }).where(sql`id = ${a.id}`)
    await recordAudit({
      workspaceId: ws.id,
      actorId: legal.id,
      action: 'approval.approved',
      subjectType: 'asset',
      subjectId: a.id,
      summary: `Fully approved after ${chain.steps.length} step(s) in ${((cursor.getTime() - requestedAt.getTime()) / 3600000).toFixed(1)}h.`,
      payload: { requestId: req.id, resolutionMs: cursor.getTime() - requestedAt.getTime() },
    })
    approvedCount++
  }
  log(`Approvals: ${approvedCount} completed, ${pendingCount} pending (1 overdue), 1 rejected`)

  /* ------------------------------------------------------------ schedule */

  const approvedAssets = await db
    .select()
    .from(assets)
    .where(sql`workspace_id = ${ws.id} and status = 'approved'`)

  const segForChannel = (c: string) =>
    c === 'push' || c === 'sms' ? trialSeg.id : c === 'linkedin' ? saasSeg.id : coreSeg.id

  let published = 0
  let scheduledAhead = 0

  for (let i = 0; i < approvedAssets.length; i++) {
    const a = approvedAssets[i]
    // Paid assets always land in the past: the budget-reallocation detector
    // needs real spend and conversions on more than one paid channel to have
    // anything to compare.
    const isPaidChannel = a.channel === 'google_ads' || a.channel === 'meta_ads'
    // Roughly half the organic work is already out, half is still ahead, so the
    // calendar has both history and upcoming slots to show.
    const inPast = isPaidChannel || i % 2 === 0
    const when = inPast ? daysAgo(int(2, 24)) : new Date(Date.now() + int(1, 11) * 86_400_000)
    when.setHours(int(8, 17), 0, 0, 0)

    const isDeadLetter = inPast && i === 4
    // Mixed on purpose: the send-time panel compares model-chosen slots against
    // hand-picked ones, and the copilot only proposes a move for manual slots.
    const useAi = i % 3 !== 1

    const [item] = await db
      .insert(scheduleItems)
      .values({
        workspaceId: ws.id,
        campaignId: a.campaignId,
        assetId: a.id,
        segmentId: segForChannel(a.channel),
        channel: a.channel,
        scheduledAt: when,
        timezone: 'Europe/London',
        status: inPast ? (isDeadLetter ? 'dead_letter' : 'published') : 'scheduled',
        sendTimeSource: useAi ? 'ai' : 'manual',
        predictedLift: useAi ? Math.round((0.12 + rng() * 0.3) * 1000) / 1000 : null,
        sendTimeRationale: useAi
          ? 'Contacts in this segment engage most in the late morning, and Tuesday is the strongest weekday for this channel over the last 90 days.'
          : null,
        publishedAt: inPast && !isDeadLetter ? when : null,
        externalRef: inPast && !isDeadLetter ? `sim_${Math.floor(rng() * 1e10).toString(36)}` : null,
        attempts: isDeadLetter ? 5 : inPast ? 1 : 0,
        lastError: isDeadLetter ? 'linkedin_pages returned 503 Service Unavailable.' : null,
        createdBy: strategist.id,
        createdAt: new Date(when.getTime() - 3 * 86_400_000),
      })
      .returning()

    if (inPast && !isDeadLetter) {
      await db.update(assets).set({ status: 'published', stage: 'monitor' }).where(sql`id = ${a.id}`)
      published++
      await recordAudit({
        workspaceId: ws.id,
        actorType: 'system',
        action: 'publish.succeeded',
        subjectType: 'schedule_item',
        subjectId: item.id,
        summary: `"${a.title}" published to ${a.channel}.`,
        payload: { assetId: a.id, externalRef: item.externalRef },
      })
    } else if (isDeadLetter) {
      await recordAudit({
        workspaceId: ws.id,
        actorType: 'system',
        action: 'publish.dead_letter',
        subjectType: 'schedule_item',
        subjectId: item.id,
        summary: `Publishing "${a.title}" failed permanently after 5 attempts: 503 Service Unavailable.`,
        payload: { assetId: a.id, attempts: 5 },
      })
    } else {
      await db.update(assets).set({ status: 'scheduled', stage: 'publish' }).where(sql`id = ${a.id}`)
      scheduledAhead++
      await recordAudit({
        workspaceId: ws.id,
        actorId: strategist.id,
        action: 'schedule.created',
        subjectType: 'schedule_item',
        subjectId: item.id,
        summary: `"${a.title}" scheduled for ${when.toUTCString()} on ${a.channel}${useAi ? ' (AI-selected slot)' : ''}.`,
        payload: { assetId: a.id, source: useAi ? 'ai' : 'manual' },
      })
    }
  }
  log(`Schedule: ${published} published, ${scheduledAhead} upcoming, 1 in dead letter`)

  /* -------------------------------------------------------------- metrics */

  const publishedAssets = await db
    .select()
    .from(assets)
    .where(sql`workspace_id = ${ws.id} and status = 'published'`)

  // Deliberately shape two findings the copilot must discover on its own:
  //   fatigueId — CTR collapses in the last 3 days
  //   weakChannel — Google Ads on the launch campaign runs at a much worse CPA
  const fatigueId = publishedAssets[0]?.id
  const facts: (typeof metricFacts.$inferInsert)[] = []

  for (const a of publishedAssets) {
    const days = int(18, 40)
    const isFatiguing = a.id === fatigueId
    const baseCtr = 0.031 + rng() * 0.022
    const baseConv = 0.045 + rng() * 0.03
    const isPaid = a.channel === 'google_ads' || a.channel === 'meta_ads'
    const weakChannel = a.channel === 'google_ads'

    for (let d = days; d >= 0; d--) {
      const day = daysAgo(d)
      const dow = day.getDay()
      const weekendDamp = dow === 0 || dow === 6 ? 0.42 : 1
      const decay = Math.exp(-d / 90)

      // The fatigue signal: a sharp CTR drop inside the last three days only.
      const fatigueFactor = isFatiguing && d <= 3 ? 0.42 : 1

      const impressions = Math.round((isPaid ? int(1400, 4200) : int(700, 2600)) * weekendDamp * (0.85 + decay * 0.3))
      const ctr = baseCtr * fatigueFactor * (0.86 + rng() * 0.28)
      const clicks = Math.round(impressions * ctr)
      const opens = a.channel === 'email' ? Math.round(impressions * (0.34 + rng() * 0.14)) : 0
      const conversions = Math.round(clicks * baseConv * (weakChannel ? 0.38 : 1) * (0.8 + rng() * 0.4))
      const signups = Math.round(conversions * (0.72 + rng() * 0.24))
      const spend = isPaid ? Math.round(impressions * (weakChannel ? 0.052 : 0.031) * 100) / 100 : 0
      const revenue = conversions * (140 + rng() * 260)

      facts.push({
        workspaceId: ws.id,
        day: isoDay(day),
        campaignId: a.campaignId,
        assetId: a.id,
        segmentId: segForChannel(a.channel),
        channel: a.channel,
        impressions,
        opens,
        clicks,
        conversions,
        signups,
        pipeline: String(Math.round(revenue * 2.4)),
        revenue: String(Math.round(revenue)),
        spend: String(spend),
      })
    }
  }

  for (let i = 0; i < facts.length; i += 500) {
    await db.insert(metricFacts).values(facts.slice(i, i + 500))
  }
  log(`Metrics: ${facts.length} daily fact rows across ${publishedAssets.length} published assets`)

  /* ------------------------------------------------------ paid campaigns */

  /**
   * Five Google Ads campaigns, one at each point of the lifecycle, because the
   * controls on the campaign screen differ at every stage and a demo workspace
   * that only contains drafts hides the two that matter most: approving spend,
   * and turning it on.
   *
   * The plans are produced by the same simulator the product uses, so they are
   * structurally valid Google campaigns rather than decorative fixtures — the
   * validator runs over them and finds nothing.
   */

  const [adAccount] = await db
    .insert(adAccounts)
    .values({
      workspaceId: ws.id,
      provider: 'google_ads',
      customerId: '4820917365',
      descriptiveName: 'CY Group — Google Ads',
      currencyCode: 'GBP',
      timeZone: 'Europe/London',
      managerCustomerId: '7391045826',
      status: 'disconnected',
      lastError:
        'Google Ads credentials are not configured yet, so this account has not been verified.',
    })
    .returning()

  const adSpecs: {
    key: string
    name: string
    brief: string
    objective: 'sales' | 'leads' | 'traffic' | 'awareness'
    daily: number
    status: 'draft' | 'in_review' | 'approved' | 'paused' | 'live'
    geo: { criterionId: string; name: string }[]
    finalUrl: string
    conversionAction: string | null
    ageDays: number
  }[] = [
    {
      key: 'platform-uk',
      name: 'Aurea platform — UK enquiries',
      brief:
        'We sell marketing automation software to in-house marketing teams. I want demo bookings from heads of marketing at UK companies.',
      objective: 'leads',
      daily: 45,
      status: 'live',
      geo: [{ criterionId: '2826', name: 'United Kingdom' }],
      finalUrl: 'https://aurea.example.com/demo',
      conversionAction: `customers/4820917365/conversionActions/8814920`,
      ageDays: 26,
    },
    {
      key: 'annual-plan',
      name: 'Annual plan — direct sales',
      brief:
        'Selling our annual subscription online to marketing teams who already know what they want.',
      objective: 'sales',
      daily: 90,
      status: 'in_review',
      geo: [
        { criterionId: '2826', name: 'United Kingdom' },
        { criterionId: '2372', name: 'Ireland' },
      ],
      finalUrl: 'https://aurea.example.com/pricing',
      conversionAction: `customers/4820917365/conversionActions/8814931`,
      ageDays: 2,
    },
    {
      key: 'london',
      name: 'Agency teams — London',
      brief: 'Getting enquiries from agency marketing teams based in London.',
      objective: 'leads',
      daily: 25,
      status: 'paused',
      geo: [{ criterionId: '1006886', name: 'London, England' }],
      finalUrl: 'https://aurea.example.com/agencies',
      conversionAction: `customers/4820917365/conversionActions/8814920`,
      ageDays: 9,
    },
    {
      key: 'report',
      name: 'Benchmark report — readers',
      brief: 'Driving readers to our marketing operations benchmark report.',
      objective: 'traffic',
      daily: 12,
      status: 'approved',
      geo: [{ criterionId: '2826', name: 'United Kingdom' }],
      finalUrl: 'https://aurea.example.com/report',
      conversionAction: null,
      ageDays: 1,
    },
    {
      key: 'ecom',
      name: 'E-commerce teams — draft',
      brief: 'We want orders from e-commerce marketing teams for the starter plan.',
      objective: 'sales',
      daily: 18,
      status: 'draft',
      geo: [{ criterionId: '2826', name: 'United Kingdom' }],
      finalUrl: 'https://aurea.example.com/starter',
      conversionAction: null,
      ageDays: 0.3,
    },
  ]

  let pushLogRows = 0
  for (const spec of adSpecs) {
    const objective = objectiveDef(spec.objective)
    const structure = simulateStructure({
      workspaceId: ws.id,
      seedId: `seed:${spec.key}`,
      brief: spec.brief,
      objective: spec.objective,
      businessName: ws.name,
      finalUrl: spec.finalUrl,
      currencyCode: 'GBP',
      dailyBudget: spec.daily,
      locations: spec.geo.map((g) => g.name),
    })

    const inGoogle = spec.status === 'paused' || spec.status === 'live'

    const [row] = await db
      .insert(adCampaigns)
      .values({
        workspaceId: ws.id,
        accountId: adAccount.id,
        name: spec.name,
        objective: spec.objective,
        channelType: objective.channelType,
        status: spec.status,
        dailyBudgetMicros: toMicros(spec.daily),
        currencyCode: 'GBP',
        biddingStrategy: objective.biddingStrategy,
        startDate: isoDay(daysAgo(spec.ageDays)),
        geoTargets: spec.geo,
        languages: ['1000'],
        finalUrl: spec.finalUrl,
        conversionAction: spec.conversionAction,
        briefText: spec.brief,
        structure,
        version: 1,
        createdBy: strategist.id,
        createdAt: daysAgo(spec.ageDays),
        updatedAt: daysAgo(spec.ageDays * 0.4),
      })
      .returning()

    /* Anything that reached Google carries the receipt that says so. Running
       the real payload through the real simulator means the stored request is
       the one the live client would have sent, not a hand-written stand-in. */
    if (inGoogle) {
      const operations = buildCampaignOperations({
        customerId: adAccount.customerId,
        campaignName: spec.name,
        channelType: objective.channelType,
        biddingStrategy: objective.biddingStrategy,
        dailyBudgetMicros: toMicros(spec.daily),
        startDate: isoDay(daysAgo(spec.ageDays)),
        geoTargets: spec.geo.map((g) => g.criterionId),
        languages: ['1000'],
        finalUrl: spec.finalUrl,
        conversionAction: spec.conversionAction,
        structure,
      })
      const result = simulateMutate(operations, {
        customerId: adAccount.customerId,
        seed: row.id,
      })
      const created = readMutateResponse(result.data)

      await db
        .update(adCampaigns)
        .set({
          externalCampaignId: created.campaign ?? null,
          externalBudgetId: created.budget ?? null,
          externalResourceNames: {
            campaign: created.campaign ?? '',
            budget: created.budget ?? '',
            adGroups: created.adGroups.join(','),
            ads: created.ads.join(','),
          },
          pushedAt: daysAgo(spec.ageDays * 0.8),
          wentLiveAt: spec.status === 'live' ? daysAgo(spec.ageDays * 0.75) : null,
        })
        .where(sql`${adCampaigns.id} = ${row.id}`)

      await db.insert(adPushLog).values({
        workspaceId: ws.id,
        adCampaignId: row.id,
        action: 'create',
        ok: true,
        simulated: true,
        requestId: result.requestId ?? null,
        operationCount: operations.length,
        request: { operations },
        response: result.data as Record<string, unknown>,
        actorId: ops.id,
        createdAt: daysAgo(spec.ageDays * 0.8),
      })
      pushLogRows++

      if (spec.status === 'live') {
        await db.insert(adPushLog).values({
          workspaceId: ws.id,
          adCampaignId: row.id,
          action: 'enable',
          ok: true,
          simulated: true,
          requestId: 'sim-status-enabled',
          operationCount: 1,
          request: { resourceName: created.campaign, status: 'ENABLED' },
          response: { mutateOperationResponses: [{ campaignResult: { resourceName: created.campaign } }] },
          actorId: owner.id,
          createdAt: daysAgo(spec.ageDays * 0.75),
        })
        pushLogRows++
      }
    }

    /* Anything at 'approved' or beyond needs a completed approval on record at
       the current version, or `assertPushable` will refuse — correctly. Without
       this the demo's "Send to Google" button is permanently disabled and looks
       like a bug rather than the gate working. */
    if (spec.status === 'approved' || inGoogle) {
      const monthly = spec.daily * 30.4
      const chain = monthly >= 2500 ? highSpendChain : paidChain
      const requestedAt = daysAgo(spec.ageDays * 0.95)
      const completedAt = daysAgo(spec.ageDays * 0.85)
      const [req] = await db
        .insert(approvalRequests)
        .values({
          workspaceId: ws.id,
          subjectType: 'ad_campaign',
          subjectId: row.id,
          chainId: chain.id,
          currentStep: chain.steps.length - 1,
          status: 'approved',
          subjectVersion: 1,
          requestedBy: strategist.id,
          requestedAt,
          completedAt,
          resolutionMs: completedAt.getTime() - requestedAt.getTime(),
        })
        .returning({ id: approvalRequests.id })

      await db.insert(approvalDecisions).values(
        chain.steps.map((step, i) => ({
          requestId: req.id,
          step: i,
          userId: step.role === 'admin' ? ops.id : step.role === 'owner' ? owner.id : legal.id,
          decision: 'approve' as const,
          comment: i === 0 ? 'Claims check clean. Budget ceiling noted.' : null,
          createdAt: new Date(requestedAt.getTime() + (i + 1) * 900_000),
        })),
      )
    }

    /* The one awaiting review gets a real open request, so the approvals queue
       has a paid item in it and the campaign screen has a decision to make.
       £90/day is roughly £2,736 a month, which is over the high-spend
       threshold — so it correctly picks up the three-step chain. */
    if (spec.status === 'in_review') {
      const monthly = spec.daily * 30.4
      const chain = monthly >= 2500 ? highSpendChain : paidChain
      await db.insert(approvalRequests).values({
        workspaceId: ws.id,
        subjectType: 'ad_campaign',
        subjectId: row.id,
        chainId: chain.id,
        currentStep: 0,
        status: 'pending',
        subjectVersion: 1,
        requestedBy: strategist.id,
        requestedAt: daysAgo(spec.ageDays * 0.5),
        dueAt: new Date(Date.now() + 6 * 3_600_000),
      })

      await recordAudit({
        workspaceId: ws.id,
        actorId: strategist.id,
        action: 'approval.requested',
        subjectType: 'ad_campaign',
        subjectId: row.id,
        summary: `"${spec.name}" submitted to "${chain.name}" — step 1 of ${chain.steps.length} (${chain.steps[0].name}).`,
        payload: { monthlySpend: Math.round(monthly), channel: 'google_ads' },
      })
    }

    await recordAudit({
      workspaceId: ws.id,
      actorId: strategist.id,
      action: 'ads.created',
      subjectType: 'ad_campaign',
      subjectId: row.id,
      summary: `"${spec.name}" — ${structure.adGroups.length} ad groups, ${structure.adGroups.reduce((n, g) => n + g.keywords.length, 0)} keywords.`,
      payload: { objective: spec.objective, simulated: true },
    })
  }

  log(
    `Google Ads: 1 account, ${adSpecs.length} campaigns (draft → live), ${pushLogRows} push-log entries`,
  )

  /* ------------------------------------------------------ notifications */

  await db.insert(notifications).values([
    {
      workspaceId: ws.id,
      userId: owner.id,
      type: 'approval.pending',
      title: 'Two assets are waiting on review',
      body: 'The Q3 Platform Launch email variants are past their SLA.',
      href: '/approvals',
      createdAt: daysAgo(0.2),
    },
    {
      workspaceId: ws.id,
      userId: owner.id,
      type: 'publish.dead_letter',
      title: 'A LinkedIn post failed to publish',
      body: 'It has moved to the dead-letter queue after 5 attempts and can be replayed.',
      href: '/scheduler',
      createdAt: daysAgo(0.6),
    },
    {
      workspaceId: ws.id,
      userId: owner.id,
      type: 'copilot',
      title: 'The copilot found 3 things worth acting on',
      body: 'Including a fatiguing creative and a cost-per-acquisition gap between channels.',
      href: '/command-center',
      createdAt: daysAgo(1.1),
    },
  ])

  /* ------------------------------------------------------ recommendations */

  const recCount = await refreshRecommendations(ws.id)
  log(`Copilot: ${recCount} recommendations computed from the seeded metrics`)

  /* ------------------------------------------------------- budget plan */

  /**
   * A live budget plan for this month across every kind of cost, with the
   * simulated market behind it: a year of channel history for the curves,
   * platform spend for pacing, and a simulated card whose charges include the
   * problems the reconciliation exists to find. Approved through the ordinary
   * chain (it matches "High spend") and made live, so the demo opens on a
   * plan that is being paced and reconciled.
   */
  {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
    await budget.syncFromAurea(ws.id)
    const plan = await budget.createPlan({
      workspaceId: ws.id,
      actorId: strategist.id,
      name: `${now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })} marketing`,
      periodStart: start,
      periodEnd: end,
      totalPence: 2_500_000,
      objective: 'conversions',
      start: 'starter',
    })
    await budget.loadSimulation({ workspaceId: ws.id, actorId: strategist.id, planId: plan.id })
    const live = (await db.select().from(adCampaigns).where(sql`workspace_id = ${ws.id}`)).map((c) => c.id)
    const google = plan.lines.find((l) => l.channelKey === 'google_ads')
    if (google && live.length) {
      await budget.saveLine({ workspaceId: ws.id, actorId: strategist.id, planId: plan.id, line: { id: google.id, channelKey: 'google_ads', plannedPence: google.plannedPence, adCampaignIds: live.slice(0, 3) } })
    }
    const meta = plan.lines.find((l) => l.channelKey === 'meta_ads')
    if (meta) {
      await budget.saveLine({
        workspaceId: ws.id,
        actorId: strategist.id,
        planId: plan.id,
        line: { id: meta.id, channelKey: 'meta_ads', plannedPence: meta.plannedPence, incrementality: 0.8, incrementalitySource: 'Meta Conversion Lift, August (illustrative)' },
      })
    }
    const { requestId } = await submitForReview({ workspaceId: ws.id, subjectType: 'budget_plan', subjectId: plan.id, actorId: strategist.id })
    // The owner may act at every step of the chain.
    for (let i = 0; i < 6; i++) {
      const r = await decideApproval({ workspaceId: ws.id, requestId, actorId: owner.id, actorRole: 'owner', decision: 'approve' })
      if (r.status === 'approved') break
    }
    await budget.activatePlan({ workspaceId: ws.id, actorId: ops.id, planId: plan.id })
    await budget.runReconciliation({ workspaceId: ws.id, actorId: ops.id, planId: plan.id })
    await budget.runAllocation({ workspaceId: ws.id, actorId: strategist.id, planId: plan.id })
    log(`Budget: live plan "${plan.name}" (£25,000) with simulated history, card and reconciliation`)
  }

  /* ----------------------------------------------------- second workspace */

  // A second, near-empty workspace proves tenant isolation is real rather than
  // theoretical: nothing above may appear here.
  const [ws2] = await db
    .insert(workspaces)
    .values({ name: 'Northwind Retail (demo)', slug: 'northwind', plan: 'trial', seats: 3, trialEndsAt: new Date(Date.now() + 14 * 86_400_000) })
    .returning()
  await db.insert(memberships).values({ workspaceId: ws2.id, userId: owner.id, role: 'owner' })
  await db.insert(subscriptions).values({ workspaceId: ws2.id, plan: 'trial', status: 'trialing', seats: 3 })
  await db.insert(brandProfiles).values({
    workspaceId: ws2.id,
    name: 'Northwind — default',
    isDefault: true,
    voice: 'Friendly, plain and practical.',
  })
  await db.insert(approvalChains).values({
    workspaceId: ws2.id,
    name: 'Northwind review',
    scope: {},
    steps: [{ name: 'Marketing review', role: 'approver', mode: 'any', slaHours: 24 }],
    isDefault: true,
  })
  log(`Second workspace "${ws2.name}" created for tenant-isolation checks`)

  console.log('\n✓ Seed complete\n')
  console.log('  Sign in at http://localhost:3000/login')
  console.log('  ─────────────────────────────────────────────')
  for (const p of people) {
    console.log(`  ${p.email.padEnd(34)} ${p.role.padEnd(11)} Aurea2026!`)
  }
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n✗ Seed failed:\n', e)
    process.exit(1)
  })
