import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CircleAlert, CircleCheck, CircleX, ExternalLink } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { listNotifications } from '@/lib/notifications'
import { getRun, GOAL_LABEL } from '@/lib/agent/service'
import type { GoalKind } from '@/lib/agent'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'
import { Report, SOURCE_LABEL } from '@/components/agent/report'

export const metadata: Metadata = { title: 'Agent run' }

const TIER: Record<string, { label: string; tone: 'neutral' | 'info' | 'warn' }> = {
  auto: { label: 'read', tone: 'neutral' }, propose: { label: 'draft for review', tone: 'info' }, gated: { label: 'acts, within rules', tone: 'warn' },
}

/** One run, in full: what it was asked, what it looked at, what it found, what it created, and what was removed from its report. */
export default async function AgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireAuth()
  const [run, notifications] = await Promise.all([getRun(auth.workspace.id, id), listNotifications(auth.workspace.id, auth.user.id)])
  if (!run) notFound()
  const title = run.goal === 'ask' ? 'Question' : GOAL_LABEL[run.goal as GoalKind]

  return (
    <>
      <Topbar user={auth.user} role={auth.role} title={title} description={run.goal === 'ask' ? run.question ?? undefined : 'Growth agent run'} notifications={notifications} />
      <PageBody>
        <Link href="/agent" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" /> Growth agent</Link>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHeader
                title="Report"
                actions={
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <Badge tone={run.status === 'done' ? 'ok' : run.status === 'failed' ? 'danger' : 'info'}>{run.status}</Badge>
                    {run.simulated && <Badge tone="info">Simulated</Badge>}
                    <span>{run.trigger}</span>
                    <RelativeTime date={run.startedAt} />
                  </span>
                }
              />
              <div className="p-5">
                {run.error && <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg">{run.error}</p>}
                {run.report ? <Report text={run.report} evidence={run.evidence} /> : <p className="text-sm text-ink-muted">{run.status === 'running' ? 'Still working…' : 'No report.'}</p>}
                {run.dropped.length > 0 && (
                  <details className="mt-4 rounded-lg border border-line px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-ink-muted">{run.dropped.length} sentence{run.dropped.length > 1 ? 's' : ''} removed because the evidence did not support {run.dropped.length > 1 ? 'them' : 'it'}</summary>
                    <ul className="mt-2 space-y-1.5">
                      {run.dropped.map((d, i) => (
                        <li key={i} className="text-xs"><span className="text-ink line-through decoration-ink-faint">{d.sentence}</span> <span className="text-ink-faint">({d.why})</span></li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </Card>

            {run.proposals.length > 0 && (
              <Card>
                <CardHeader title="What it created" description="Leads land unassigned in the CRM's first stage; pull requests are drafts until a person merges them." />
                <ul className="divide-y divide-line">
                  {run.proposals.map((p, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
                      <Badge tone={p.status === 'refused' ? 'warn' : p.status === 'sent' ? 'brand' : 'ok'}>{p.kind}</Badge>
                      <span className="text-ink">{p.title}</span>
                      <span className="text-xs text-ink-muted">{p.status}</span>
                      {p.url && /^https:\/\//.test(p.url) && <a href={p.url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline">Open <ExternalLink className="h-3 w-3" /></a>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card>
              <CardHeader title="Evidence" description="Every citation in the report points here." />
              {run.evidence.length === 0 ? <p className="p-5 text-sm text-ink-muted">None.</p> : (
                <ul className="divide-y divide-line">
                  {run.evidence.map((e) => (
                    <li key={e.id} id={e.id} className="flex items-start gap-3 px-5 py-2.5 text-sm target:bg-brand-50">
                      <span className="mt-0.5 w-9 shrink-0 text-2xs font-semibold text-brand-700">{e.id}</span>
                      <span className="min-w-0 flex-1">
                        <span className="text-ink">{e.label}</span>
                        <span className="mt-0.5 block text-2xs text-ink-faint">{SOURCE_LABEL[e.source] ?? e.source}</span>
                      </span>
                      {e.url && /^https:\/\//.test(e.url) && <a href={e.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-medium text-brand-700 hover:underline">Check</a>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader title="What it did" />
              <ol className="space-y-3 p-5">
                {run.steps.length === 0 && <li className="text-sm text-ink-muted">No tools used.</li>}
                {run.steps.map((s) => (
                  <li key={s.n} className="flex gap-2.5">
                    {s.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok-fg" /> : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="text-xs font-semibold text-ink">{s.tool}</code>
                        {s.tier && <Badge tone={TIER[s.tier]?.tone ?? 'neutral'}>{TIER[s.tier]?.label ?? s.tier}</Badge>}
                      </div>
                      <p className="mt-0.5 whitespace-pre-line break-words text-xs text-ink-muted">{s.summary}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
            <Card>
              <CardHeader title="Run" />
              <dl className="grid grid-cols-2 gap-y-2 p-5 text-xs">
                <dt className="text-ink-muted">Model</dt><dd className="text-ink">{run.model}</dd>
                <dt className="text-ink-muted">Tokens</dt><dd className="text-ink">{(run.usage.input + run.usage.output).toLocaleString('en-GB')}</dd>
                <dt className="text-ink-muted">Stopped</dt><dd className="text-ink">{run.stoppedBecause ?? '—'}</dd>
                <dt className="text-ink-muted">Finished</dt><dd className="text-ink"><RelativeTime date={run.finishedAt} /></dd>
              </dl>
              {run.stoppedBecause && run.stoppedBecause !== 'done' && (
                <p className="mx-5 mb-5 flex items-start gap-1.5 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn-fg"><CircleAlert className="mt-0.5 h-3.5 w-3.5" /> Stopped early ({run.stoppedBecause.replace(/_/g, ' ')}).</p>
              )}
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  )
}
