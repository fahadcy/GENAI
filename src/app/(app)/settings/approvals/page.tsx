import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Clock, GitBranch, ShieldCheck, ThumbsDown } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Card, StatTile } from '@/components/ui/primitives'
import { CHANNEL_META, formatDurationMs, formatPercent } from '@/components/domain'
import { ChainBuilder, ChainMatchTester } from '@/components/settings/chain-builder'
import { BlackoutWindows, FrequencyCaps } from '@/components/settings/guards'
import { ReadOnlyNotice } from '@/components/settings/bits'
import type { Channel } from '@/lib/db/schema'
import { approvalThroughput, chainOverview, schedulingGuards } from '../queries'

export const metadata: Metadata = { title: 'Approvals' }

export default async function ApprovalSettingsPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const currency = auth.workspace.settings.currency ?? 'GBP'

  const [{ chains, roleHeadcount }, guards, throughput] = await Promise.all([
    chainOverview(wsId),
    schedulingGuards(wsId),
    approvalThroughput(wsId),
  ])

  const canEditChains = can(auth.role, 'approval:configure')
  const canEditGuards = can(auth.role, 'schedule:edit')

  const decided = throughput.approved + throughput.rejected
  const rejectRate = decided > 0 ? throughput.rejected / decided : null
  const activeChains = chains.filter((c) => c.chain.active)
  const stalling = chains.filter((c) => c.chain.active && c.unstaffedSteps.length > 0)

  return (
    <PageBody className="max-w-[1240px]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Active chains"
          value={activeChains.length}
          hint={`${activeChains.reduce((a, c) => a + c.chain.steps.length, 0)} steps across every route`}
          icon={<GitBranch className="h-4 w-4" />}
        />
        <StatTile
          label="Average approval time"
          value={formatDurationMs(throughput.avgMs)}
          hint={`${throughput.approved} approved to date`}
          icon={<Clock className="h-4 w-4" />}
        />
        <StatTile
          label="Waiting on a decision"
          value={throughput.pending}
          delta={
            throughput.overdue > 0
              ? { value: `${throughput.overdue} past SLA`, direction: 'up', good: false }
              : undefined
          }
          hint={throughput.overdue === 0 ? 'all within SLA' : undefined}
          href="/approvals"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatTile
          label="Changes requested"
          value={rejectRate === null ? '—' : formatPercent(rejectRate, 0)}
          hint={`${throughput.rejected} of ${decided} decisions sent work back`}
          icon={<ThumbsDown className="h-4 w-4" />}
        />
      </div>

      {stalling.length > 0 && (
        <Card className="mt-6 border-danger-fg/30 bg-danger-bg/40 p-4">
          <p className="text-[13px] font-semibold text-danger-fg">
            {stalling.length} active chain{stalling.length === 1 ? ' has' : 's have'} a step nobody can
            clear
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            {stalling.map((c) => `"${c.chain.name}" (${c.unstaffedSteps.join(', ')})`).join('; ')}. Work
            routed here would sit in review indefinitely. Either assign someone the role on{' '}
            <Link href="/settings/members" className="font-medium text-ink underline underline-offset-2">
              the people page
            </Link>{' '}
            or change the step to a role that is staffed.
          </p>
        </Card>
      )}

      <div className="mt-6">
        <ChainMatchTester
          channels={Object.keys(CHANNEL_META) as Channel[]}
          currency={currency}
          defaultSpend={auth.workspace.settings.requireApprovalAboveSpend ?? 1000}
        />
      </div>

      <div className="mt-6">
        {!canEditChains && (
          <div className="mb-3">
            <ReadOnlyNotice what="the approval chains" />
          </div>
        )}
        <ChainBuilder
          chains={chains}
          roleHeadcount={roleHeadcount}
          currency={currency}
          canEdit={canEditChains}
        />
      </div>

      <div className="mt-8">
        <SectionHeading
          title="Send guards"
          description="Approval decides whether something may go out. These decide when, and how often."
          actions={
            <Link
              href="/scheduler"
              className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
            >
              See the calendar
              <ArrowRight className="h-3 w-3" />
            </Link>
          }
        />
        {/* Stacked rather than side by side: both cards are wide sentences
            ("at most 3 messages per contact every 7 days"), and squeezing them
            into half a column wrapped every row onto three lines. */}
        <div className="grid gap-5">
          <BlackoutWindows
            canEdit={canEditGuards}
            timezone={auth.workspace.settings.defaultTimezone}
            windows={guards.windows.map((w) => ({
              id: w.id,
              name: w.name,
              startsAt: w.startsAt.toISOString(),
              endsAt: w.endsAt.toISOString(),
              channels: w.channels,
              reason: w.reason,
            }))}
          />
          <FrequencyCaps
            canEdit={canEditGuards}
            caps={guards.caps.map((c) => ({
              id: c.id,
              channel: c.channel,
              maxPerContact: c.maxPerContact,
              windowDays: c.windowDays,
            }))}
          />
        </div>
      </div>
    </PageBody>
  )
}
