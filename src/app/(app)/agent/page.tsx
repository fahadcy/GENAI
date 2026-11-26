import type { Metadata } from 'next'
import Link from 'next/link'
import { Bot, CircleCheck, CircleDashed, History, MessageCircleQuestion, PlugZap, Target } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { connectionView, crmBusiness, crmBusinesses, GOAL_LABEL, listRuns, openQuestions } from '@/lib/agent/service'
import type { GoalKind } from '@/lib/agent'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader, EmptyState, KeyValue } from '@/components/ui/primitives'
import { Disclosure } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'
import { Report } from '@/components/agent/report'
import {
  AskBox, ChooseBusiness, ConnectCrmForm, ConnectGithubForm, DisconnectCrm, QuestionsForm, RunButtons, ScheduleForm, ScopeBadges, TargetsForm,
} from '@/components/agent/controls'

export const metadata: Metadata = { title: 'Growth agent' }
export const dynamic = 'force-dynamic'

/**
 * The growth agent. Three states: not connected (connect the CRM), connected
 * without a business chosen, and working: ask, run a routine, read the latest
 * report, answer its questions, set targets and schedule.
 */
export default async function AgentPage() {
  const auth = await requireAuth()
  const ws = auth.workspace.id
  const canRun = can(auth.role, 'agent:run')
  const canOutreach = can(auth.role, 'agent:outreach')
  const canConfigure = can(auth.role, 'agent:configure')
  const [view, notifications] = await Promise.all([connectionView(ws), listNotifications(ws, auth.user.id)])

  const topbar = (
    <Topbar
      user={auth.user}
      role={auth.role}
      title="Growth agent"
      description="Knows the business, reads the pipeline, finds leads that fit, follows up within the rules, and drafts website content for review"
      notifications={notifications}
    />
  )

  if (!view?.crmTokenHint) {
    return (
      <>
        {topbar}
        <PageBody width="narrow">
          <Card>
            <CardHeader icon={<PlugZap className="h-4 w-4" />} title="Connect your CRM" description="The agent works through your CRM's agent API, with a token you create there. It can read the pipeline and add leads, notes and tasks; it never changes stages or owners." />
            <div className="p-5">
              {canConfigure ? (
                <ConnectCrmForm connected={false} />
              ) : (
                <EmptyState icon={<Bot className="h-5 w-5" />} title="Not connected yet" description="An owner or marketing ops can connect the CRM. Once they have, you can use the agent here." />
              )}
            </div>
          </Card>
          <p className="mt-4 text-xs text-ink-muted">
            In the CRM: Admin → Users → 🤖 Growth agent → Access tokens. Start with the <b>read</b> and <b>write</b> scopes; add <b>outreach</b> only when email is set up and approved (AGENT_SETUP.md in the CRM update).
          </p>
        </PageBody>
      </>
    )
  }

  if (!view.crmBusinessId) {
    const businesses = await crmBusinesses(ws)
    return (
      <>
        {topbar}
        <PageBody width="narrow">
          <Card>
            <CardHeader title="Which business does the agent work for?" description="Your CRM token can see more than one business. The agent works for one at a time." />
            <div className="p-5">
              {businesses.length ? (canConfigure ? <ChooseBusiness businesses={businesses} /> : <p className="text-sm text-ink-muted">An owner or marketing ops needs to choose.</p>)
                : <p className="text-sm text-danger-fg">The CRM could not be reached with the saved token. Connect it again.</p>}
            </div>
          </Card>
        </PageBody>
      </>
    )
  }

  const [runs, questions, biz] = await Promise.all([listRuns(ws, 12), openQuestions(ws), crmBusiness(ws)])
  const latest = runs.find((r) => r.status === 'done' && r.report && r.goal !== 'ask')
  const asks = runs.filter((r) => r.goal === 'ask').slice(0, 3)
  const approved = biz?.templates.filter((t) => t.approved_for_agent).length ?? 0
  const outreachWhy = !view.crmScopes.includes('outreach') ? 'CRM token has no outreach scope'
    : !biz ? 'CRM not reachable'
    : !biz.outreach.enabled ? 'Switched off in the CRM'
    : biz.outreach.paused ? `Paused in the CRM: ${biz.outreach.paused_reason}`
    : approved === 0 ? 'No template approved in the CRM' : ''

  return (
    <>
      {topbar}
      <PageBody>
        {!view.liveModel && (
          <div className="mb-4 rounded-xl border border-line bg-info-bg px-4 py-3 text-sm text-info-fg">
            <b>Simulated mode.</b> No language model key is set, so the agent follows fixed routines and writes its reports from the evidence alone. Everything it reads and creates is real. Add <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> for answers in its own words.
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHeader icon={<MessageCircleQuestion className="h-4 w-4" />} title="Ask" description={`Answers come from ${view.crmBusinessName ?? 'your'} CRM data, Companies House and what you have told it. Every figure links to its source.`} />
              <div className="space-y-3 p-5">
                <AskBox disabled={!canRun} />
                {asks.length > 0 && (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {asks.map((a) => (
                      <li key={a.id}>
                        <Link href={`/agent/runs/${a.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-hover">
                          <span className="truncate text-ink">{a.question}</span>
                          <RelativeTime date={a.startedAt} className="shrink-0 text-xs text-ink-faint" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader icon={<Bot className="h-4 w-4" />} title="Routines" description="Run one now, or let the schedule run them." />
              <div className="p-5">
                <RunButtons canRun={canRun} canOutreach={canOutreach} outreachReady={!outreachWhy} outreachWhy={outreachWhy} siteConnected={!!view.githubRepo && view.liveModel} chConnected={view.companiesHouse} />
              </div>
            </Card>

            <Card>
              <CardHeader
                title={latest ? `Latest: ${GOAL_LABEL[latest.goal as GoalKind]}` : 'No report yet'}
                description={latest ? undefined : 'Run the daily brief to see what needs attention.'}
                actions={latest ? (
                  <span className="flex items-center gap-2 text-xs text-ink-muted">
                    {latest.simulated && <Badge tone="info">Simulated</Badge>}
                    <RelativeTime date={latest.startedAt} />
                    <Link className="font-medium text-brand-700 hover:underline" href={`/agent/runs/${latest.id}`}>Details</Link>
                  </span>
                ) : undefined}
              />
              {latest && (
                <div className="p-5">
                  <Report text={latest.report ?? ''} evidence={latest.evidence} runHref={`/agent/runs/${latest.id}`} />
                  {latest.proposals.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {latest.proposals.slice(0, 12).map((p, i) => (
                        <Badge key={i} tone={p.status === 'refused' ? 'warn' : 'ok'}>{p.kind}: {p.title}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader icon={<History className="h-4 w-4" />} title="Recent runs" />
              {runs.length === 0 ? (
                <p className="p-5 text-sm text-ink-muted">Nothing yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <Link href={`/agent/runs/${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm hover:bg-surface-hover">
                        <span className="font-medium text-ink">{r.goal === 'ask' ? `“${(r.question ?? '').slice(0, 60)}”` : GOAL_LABEL[r.goal as GoalKind]}</span>
                        <Badge tone={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Badge>
                        <span className="text-xs text-ink-muted">{r.trigger}{r.simulated ? ' · simulated' : ''} · {r.proposals.filter((p) => p.status !== 'refused').length} created</span>
                        <RelativeTime date={r.startedAt} className="ml-auto text-xs text-ink-faint" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Status" />
              <div className="p-5">
                <KeyValue items={[
                  { label: 'CRM business', value: view.crmBusinessName ?? `#${view.crmBusinessId}` },
                  { label: 'Token', value: <span className="inline-flex flex-wrap items-center gap-1.5"><code className="text-xs">{view.crmTokenHint}</code><ScopeBadges scopes={view.crmScopes} /></span> },
                  { label: 'Email outreach', value: outreachWhy ? <span className="text-ink-muted">Off: {outreachWhy.toLowerCase()}</span> : <span className="inline-flex items-center gap-1 text-ok-fg"><CircleCheck className="h-3.5 w-3.5" /> On, {biz!.outreach.daily_cap} a day max</span> },
                  { label: 'Companies House', value: view.companiesHouse ? 'Connected' : <span className="text-ink-muted">Add COMPANIES_HOUSE_API_KEY</span> },
                  { label: 'Website', value: view.githubRepo ?? <span className="text-ink-muted">Not connected</span> },
                  { label: 'Model', value: view.liveModel ? view.model : <span className="inline-flex items-center gap-1 text-ink-muted"><CircleDashed className="h-3.5 w-3.5" /> Simulator</span> },
                ]} />
              </div>
            </Card>

            <Card>
              <CardHeader icon={<MessageCircleQuestion className="h-4 w-4" />} title="The agent would like to know" description="Answers outrank anything it has guessed." />
              <div className="p-5"><QuestionsForm questions={questions} answers={view.answers} canEdit={canRun} /></div>
            </Card>

            <Card>
              <CardHeader icon={<Target className="h-4 w-4" />} title="Lead targets" description="Where Find leads searches Companies House." />
              <div className="p-5"><TargetsForm initial={view.targets} canEdit={canRun} /></div>
            </Card>

            <Card>
              <CardHeader title="Schedule" />
              <div className="p-5">
                <ScheduleForm initial={view.schedule} canConfigure={canConfigure} canOutreach={canOutreach} outreachAllowedByCrm={!outreachWhy} />
              </div>
            </Card>

            {canConfigure && (
              <Card>
                <CardHeader icon={<PlugZap className="h-4 w-4" />} title="Connections" />
                <div className="space-y-3 p-5">
                  <Disclosure summary="CRM">
                    <div className="space-y-3 pt-3">
                      <ConnectCrmForm initialUrl={view.crmUrl} connected />
                      <DisconnectCrm />
                    </div>
                  </Disclosure>
                  <Disclosure summary="Website (GitHub)">
                    <div className="pt-3"><ConnectGithubForm repo={view.githubRepo} /></div>
                  </Disclosure>
                </div>
              </Card>
            )}
          </div>
        </div>
      </PageBody>
    </>
  )
}
