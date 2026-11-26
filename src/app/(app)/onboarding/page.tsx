import type { Metadata } from 'next'
import Link from 'next/link'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { approvalChains, brandProfiles, legalRules } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { PageBody } from '@/components/shell/page'
import { OnboardingFlow, type OnboardingData } from '@/components/onboarding/flow'

export const metadata: Metadata = { title: 'Get started' }

export const dynamic = 'force-dynamic'

/**
 * Post-signup guided start. Deliberately short and entirely skippable: it
 * confirms what signup already created, then gets the user to one piece of real
 * value — their own words scored by the guardrail engine — before handing off to
 * the Studio rather than reimplementing it.
 */
export default async function OnboardingPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id

  const [profiles, chains, ruleCount] = await Promise.all([
    db
      .select()
      .from(brandProfiles)
      .where(and(eq(brandProfiles.workspaceId, wsId), eq(brandProfiles.isDefault, true)))
      .limit(1),
    db
      .select()
      .from(approvalChains)
      .where(and(eq(approvalChains.workspaceId, wsId), eq(approvalChains.isDefault, true)))
      .limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(legalRules)
      .where(and(eq(legalRules.workspaceId, wsId), eq(legalRules.active, true))),
  ])

  const profile = profiles[0]
  const chain = chains[0]

  const trialDaysLeft = auth.workspace.trialEndsAt
    ? Math.max(0, Math.ceil((auth.workspace.trialEndsAt.getTime() - Date.now()) / 86_400_000))
    : null

  const data: OnboardingData = {
    firstName: auth.user.name.split(/\s+/)[0] || auth.user.name,
    workspaceName: auth.workspace.name,
    trialDaysLeft: auth.workspace.plan === 'trial' ? trialDaysLeft : null,
    legalRuleCount: Number(ruleCount[0]?.n ?? 0),
    brand: {
      name: profile?.name ?? 'Default voice',
      voice:
        profile?.voice ||
        'No voice description yet. Add one in Settings → Brand so generated work has something to aim at.',
      doList: profile?.doList ?? [],
      dontList: profile?.dontList ?? [],
      bannedTerms: profile?.bannedTerms ?? [],
      passThreshold: profile?.passThreshold ?? 80,
      readingLevelMax: profile?.readingLevelMax ?? 11,
      tone: profile?.tone ?? { formal: 55, playful: 35, technical: 45, urgent: 30, warm: 60 },
    },
    chain: chain
      ? {
          name: chain.name,
          description: chain.description,
          steps: chain.steps.map((s) => ({ name: s.name, role: s.role, slaHours: s.slaHours })),
        }
      : null,
  }

  return (
    <>
      <PageBody width="narrow" className="py-10 lg:py-14">
        <div className="mx-auto mb-8 flex w-full max-w-3xl flex-col-reverse items-start gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-brand-600">
              Getting started
            </p>
            <h1 className="mt-2 text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">
              Welcome, {data.firstName}.
            </h1>
            <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-muted">
              Four short steps, about three minutes. You can leave at any point — nothing here is
              required, and everything it shows you can be changed later.
            </p>
          </div>
          <Link
            href="/command-center"
            className="-ml-2.5 shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink sm:ml-0 sm:mt-1"
          >
            Skip setup
          </Link>
        </div>

        <OnboardingFlow data={data} />
      </PageBody>
    </>
  )
}
