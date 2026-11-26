import type { Metadata } from 'next'
import { CalendarClock, CreditCard, Layers, Users } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { hasLiveModel } from '@/lib/env'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Badge, Card, StatTile } from '@/components/ui/primitives'
import { formatMoney } from '@/components/domain'
import { AiSpendPanel, PlanPicker, UsageMeters } from '@/components/settings/billing'
import { ReadOnlyNotice } from '@/components/settings/bits'
import { basePrice, monthlyPrice, stackTotal, tierFor } from '@/components/settings/plans'
import { billingOverview } from '../queries'

export const metadata: Metadata = { title: 'Plan & usage' }

export default async function BillingPage() {
  const auth = await requireAuth()
  const data = await billingOverview(auth.workspace.id)
  const canManage = can(auth.role, 'billing:manage')

  const plan = data.subscription?.plan ?? auth.workspace.plan
  const seats = data.subscription?.seats ?? auth.workspace.seats
  const tier = tierFor(plan)
  const price = monthlyPrice(tier, seats)
  const stack = stackTotal(tier)
  const base = basePrice(tier)
  const saving = base !== null ? stack - base : null

  const status = data.subscription?.status ?? 'trialing'
  const renews = data.subscription?.currentPeriodEnd ?? auth.workspace.trialEndsAt

  /* Metered usage is counted from the tables that produce it. `usageCounters`
     is the roll-up the billing worker writes; where it disagrees with the live
     count, the live count is what the customer would be charged on. */
  const counterFor = (metric: string) =>
    data.counters.find((c) => c.metric === metric && c.period === new Date().toISOString().slice(0, 7))

  const meters = [
    {
      label: 'Assets generated',
      value: counterFor('assets_generated')?.value ?? data.usage.assetsGenerated,
      limit: tier.limits.assetsPerMonth,
      hint: 'every AI-produced variant created this calendar month',
    },
    {
      label: 'Contacts on file',
      value: data.usage.contacts,
      limit: tier.limits.contacts,
      hint: 'the audience the targeting engine evaluates against',
    },
    {
      label: 'Sends published',
      value: data.usage.assetsPublished,
      limit: null,
      hint: 'delivered through connected integrations this month',
    },
    {
      label: 'Model calls',
      value: data.usage.aiRuns,
      limit: null,
      hint: 'generation, planning and segment interpretation',
    },
  ]

  return (
    <PageBody className="max-w-[1240px]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Current plan"
          value={tier.name}
          hint={status === 'trialing' ? 'evaluating' : status === 'active' ? 'active subscription' : status}
          icon={<CreditCard className="h-4 w-4" />}
        />
        <StatTile
          label="Monthly"
          value={price === null ? 'Custom' : formatMoney(price, 'GBP')}
          hint={
            tier.billing === 'per_seat'
              ? `${seats} seat${seats === 1 ? '' : 's'} at ${formatMoney(tier.price ?? 0, 'GBP')}`
              : `${tier.includedSeats} seats included`
          }
          icon={<Layers className="h-4 w-4" />}
        />
        <StatTile
          label="Seats in use"
          value={`${data.seatsUsed} / ${seats}`}
          delta={
            data.pendingInvites > 0
              ? { value: `${data.pendingInvites} invited`, direction: 'up' }
              : undefined
          }
          hint={data.pendingInvites === 0 ? `${Math.max(0, seats - data.seatsUsed)} free` : undefined}
          href="/settings/members"
          icon={<Users className="h-4 w-4" />}
        />
        <StatTile
          label={status === 'trialing' ? 'Trial ends' : 'Renews'}
          value={
            renews
              ? renews.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
              : '—'
          }
          hint={
            renews
              ? `${Math.max(0, Math.ceil((renews.getTime() - Date.now()) / 86_400_000))} days away`
              : 'no billing period on record'
          }
          icon={<CalendarClock className="h-4 w-4" />}
        />
      </div>

      {/* The positioning argument, priced against the tier this workspace is
          actually on rather than a generic marketing claim. */}
      {saving !== null && saving > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">One subscription instead of four</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
                Running this workspace's brief-to-published loop on separate tools means a content
                platform, a scheduler, a marketing automation suite and a review tool — and still no
                single audit trail across them. At published list prices that stack is{' '}
                {formatMoney(stack, 'GBP')} a month before anyone has integrated it — against{' '}
                {formatMoney(base ?? 0, 'GBP')} for {tier.name} at its {tier.includedSeats} included
                seat{tier.includedSeats === 1 ? '' : 's'}.
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="tnum text-2xl font-semibold leading-none tracking-tight text-ok-fg">
                {formatMoney(saving, 'GBP')}
              </p>
              <p className="mt-1.5 text-2xs text-ink-faint">
                less per month on {tier.name}
              </p>
            </div>
          </div>
          <ul className="flex flex-wrap gap-2 border-t border-line bg-bg-subtle px-5 py-3">
            {tier.replaces.map((r) => (
              <li key={r.category} className="flex items-center gap-2 text-2xs">
                <Badge tone="neutral">{r.category}</Badge>
                <span className="text-ink-muted">{r.typical}</span>
                <span className="tnum text-ink-faint">{formatMoney(r.monthly, 'GBP')}/mo</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-8">
        <SectionHeading
          title="Plan"
          description="Every tier includes the full governance loop. The difference is scale, and how much of the compliance story is on your paper rather than ours."
        />
        {!canManage && (
          <div className="mb-3">
            <ReadOnlyNotice what="the plan" />
          </div>
        )}
        <PlanPicker
          currentPlan={plan}
          currentSeats={seats}
          seatsUsed={data.seatsUsed}
          canManage={canManage}
        />
      </div>

      <div className="mt-8 grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <UsageMeters
          planName={tier.name}
          limits={
            tier.limits.assetsPerMonth === null
              ? 'This plan has no volume caps.'
              : `${tier.name} includes ${tier.limits.assetsPerMonth.toLocaleString('en-GB')} generated assets a month.`
          }
          usage={meters}
        />
        <AiSpendPanel
          totals={data.ai}
          byAgent={data.aiByAgent}
          byMonth={data.aiByMonth}
          liveModel={hasLiveModel()}
        />
      </div>

      <div className="mt-8">
        <SectionHeading
          title={`What ${tier.name} includes`}
          description="Feature differences, stated plainly."
        />
        <Card className="p-5">
          <ul className="grid gap-2 sm:grid-cols-2">
            {tier.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                {f}
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-line pt-3 text-2xs leading-relaxed text-ink-faint">
            Audit retention on this plan:{' '}
            {tier.limits.auditRetentionMonths === null
              ? 'as agreed in your contract, including legal hold.'
              : `${tier.limits.auditRetentionMonths} months.`}{' '}
            Prices exclude VAT. Comparison figures are the vendors' published list prices at the time of
            writing and are shown for orientation, not as a quotation.
          </p>
        </Card>
      </div>
    </PageBody>
  )
}
