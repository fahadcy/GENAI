/**
 * Adds an "Easy Liquidation" workspace for the PPC & SEO module, without
 * touching anything else in the database. Safe to run more than once.
 *
 * Its pages, titles, services and claims come from easyliquidation.co.uk.
 * The Google Ads, Search Console and enquiry data are simulated until real
 * exports are connected; every screen says so.
 *
 * Run: npm run seed:easyliquidation   (after npm run db:push)
 */
import '../src/lib/load-env'

import { eq, inArray } from 'drizzle-orm'
import { db } from '../src/lib/db'
import {
  approvalChains,
  brandProfiles,
  memberships,
  serpTwinProfiles,
  subscriptions,
  users,
  workspaces,
} from '../src/lib/db/schema'
import { EL_BUSINESS } from '../src/lib/serptwin/presets/easy-liquidation'

const SLUG = 'easy-liquidation'
const TEAM: Record<string, 'owner' | 'strategist' | 'creator' | 'approver' | 'admin' | 'analyst'> = {
  'fahad.ali@currieyoung.com': 'owner',
  'priya@currieyoung.com': 'strategist',
  'marcus@currieyoung.com': 'creator',
  'elena@currieyoung.com': 'approver',
  'daniel@currieyoung.com': 'admin',
  'grace@currieyoung.com': 'analyst',
}

async function main() {
  const [existing] = await db.select().from(workspaces).where(eq(workspaces.slug, SLUG)).limit(1)
  const ws =
    existing ??
    (
      await db
        .insert(workspaces)
        .values({
          name: 'Easy Liquidation',
          slug: SLUG,
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
    )[0]!

  if (!existing) {
    await db.insert(subscriptions).values({
      workspaceId: ws.id,
      plan: 'growth',
      status: 'active',
      seats: 12,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    })

    const people = await db.select().from(users).where(inArray(users.email, Object.keys(TEAM)))
    if (people.length === 0) throw new Error('No demo users found. Run npm run db:seed first.')
    await db
      .insert(memberships)
      .values(people.map((u) => ({ workspaceId: ws.id, userId: u.id, role: TEAM[u.email]! })))

    await db.insert(brandProfiles).values({
      workspaceId: ws.id,
      name: 'Easy Liquidation — voice',
      isDefault: true,
      voice:
        'Calm, plain and reassuring. Directors who contact us are often worried; we explain what happens next in simple steps, without jargon or pressure.',
      tone: { formal: 60, playful: 5, technical: 35, urgent: 30, warm: 75 },
      doList: [
        'Say what happens next, step by step',
        'State the fee plainly ("from £1,499") and what changes it',
        'Answer the personal-liability worry directly',
      ],
      dontList: [
        'Promise that debts will be written off',
        'Use fear to push a decision',
        'Give advice that depends on facts we do not have',
      ],
      bannedTerms: ['guaranteed', 'debt free', 'write off all your debts'],
      preferredTerms: [{ avoid: 'wind up your business', use: 'close your company' }],
      requiredDisclaimers: [],
      readingLevelMax: 9,
      maxExclamations: 0,
      colors: { primary: '#1F4E79', secondary: '#0E1116', accent: '#E8B341' },
      passThreshold: 80,
    })

    await db.insert(approvalChains).values([
      {
        workspaceId: ws.id,
        name: 'Standard content',
        description: 'Owned channels: one marketing review before publishing.',
        scope: { channels: ['email', 'linkedin', 'blog', 'web', 'x', 'sms', 'push'] },
        steps: [{ name: 'Marketing review', role: 'approver', mode: 'any', slaHours: 8 }],
        isDefault: true,
        priority: 0,
      },
      {
        workspaceId: ws.id,
        name: 'Paid media',
        description: 'Anything with spend behind it goes through compliance, then ops.',
        scope: { channels: ['google_ads', 'meta_ads', 'facebook', 'instagram'] },
        steps: [
          { name: 'Legal review', role: 'approver', mode: 'any', slaHours: 12 },
          { name: 'Ops sign-off', role: 'admin', mode: 'any', slaHours: 6 },
        ],
        isDefault: false,
        priority: 10,
      },
    ])
  }

  // The profile row decides which simulated account the analysis runs on.
  const [profile] = await db
    .select()
    .from(serpTwinProfiles)
    .where(eq(serpTwinProfiles.workspaceId, ws.id))
    .limit(1)
  if (!profile) {
    await db
      .insert(serpTwinProfiles)
      .values({ workspaceId: ws.id, profile: EL_BUSINESS.business, dataset: 'easy-liquidation' })
  } else if (profile.dataset !== 'easy-liquidation') {
    await db
      .update(serpTwinProfiles)
      .set({ dataset: 'easy-liquidation' })
      .where(eq(serpTwinProfiles.workspaceId, ws.id))
  }

  console.log(`\n✓ ${existing ? 'Already there' : 'Created'}: workspace "${ws.name}"`)
  console.log('  Switch to it from the workspace menu in the sidebar, then open PPC & SEO.\n')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n✗ Seed failed:\n', e)
    process.exit(1)
  })
