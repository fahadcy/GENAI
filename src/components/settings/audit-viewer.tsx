'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Download, FileWarning, Fingerprint, Search, ShieldCheck, ShieldX, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, Input, Select, Spinner } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { exportAuditAction, verifyAuditChainAction } from '@/app/actions/approvals'

type Verification = Awaited<ReturnType<typeof verifyAuditChainAction>>

/**
 * The tamper-evidence surface.
 *
 * Every event stores sha256(prevHash ‖ canonical(event)). Verification walks the
 * whole workspace chain server-side and recomputes each link, so a row that was
 * edited, deleted or reordered is named by sequence number. That is the whole
 * difference between "we log things" and "we can prove nothing was changed".
 */
export function IntegrityPanel({
  totalEvents,
  firstEventAt,
  lastEventAt,
  canExport,
}: {
  totalEvents: number
  firstEventAt: string | null
  lastEventAt: string | null
  canExport: boolean
}) {
  const toast = useToast()
  const [result, setResult] = React.useState<Verification | null>(null)
  const [verifying, setVerifying] = React.useState(false)
  const [verifiedAt, setVerifiedAt] = React.useState<Date | null>(null)
  const [exporting, setExporting] = React.useState(false)

  const verify = async () => {
    setVerifying(true)
    try {
      const r = await verifyAuditChainAction()
      setResult(r)
      setVerifiedAt(new Date())
      toast.push({
        tone: r.ok ? 'ok' : 'danger',
        title: r.ok
          ? `Chain intact — ${r.checked.toLocaleString('en-GB')} events verified`
          : `Chain broken at event #${r.brokenAtSeq}`,
        body: r.ok ? undefined : (r.reason ?? undefined),
      })
    } catch {
      toast.push({ tone: 'danger', title: 'Verification could not complete.' })
    } finally {
      setVerifying(false)
    }
  }

  const download = async () => {
    setExporting(true)
    try {
      const { filename, csv } = await exportAuditAction()
      // Built here rather than served from a route so the export goes through
      // the same permission check as everything else and leaves no URL behind.
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.push({ tone: 'ok', title: `Exported ${filename}` })
    } catch (e) {
      toast.push({
        tone: 'danger',
        title: e instanceof Error ? e.message : 'The export could not be produced.',
      })
    } finally {
      setExporting(false)
    }
  }

  const span =
    firstEventAt && lastEventAt
      ? `${new Date(firstEventAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} → ${new Date(lastEventAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : 'no events recorded yet'

  return (
    <Card
      className={cn(
        'overflow-hidden',
        result && (result.ok ? 'border-ok-fg/30' : 'border-danger-fg/40'),
      )}
    >
      <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
              result === null
                ? 'bg-bg-inset text-ink-faint'
                : result.ok
                  ? 'bg-ok-bg text-ok-fg'
                  : 'bg-danger-bg text-danger-fg',
            )}
          >
            {verifying ? (
              <Spinner className="h-5 w-5" />
            ) : result === null ? (
              <Fingerprint className="h-5 w-5" />
            ) : result.ok ? (
              <ShieldCheck className="h-5 w-5" />
            ) : (
              <ShieldX className="h-5 w-5" />
            )}
          </span>

          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">
              {result === null
                ? 'Tamper-evident audit trail'
                : result.ok
                  ? 'Chain verified — nothing has been altered'
                  : `Chain broken at event #${result.brokenAtSeq}`}
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
              {result === null ? (
                <>
                  Each of the {totalEvents.toLocaleString('en-GB')} events below stores a SHA-256 hash of
                  the event before it. Editing, deleting or reordering any single row breaks every hash
                  after it. Verification recomputes the whole chain and names the exact sequence number
                  where it fails.
                </>
              ) : result.ok ? (
                <>
                  All {result.checked.toLocaleString('en-GB')} events recomputed to their stored hashes,
                  and every previous-hash pointer matches the event before it. Covering {span}.
                </>
              ) : (
                result.reason
              )}
            </p>
            {verifiedAt && (
              <p className="mt-1.5 text-2xs text-ink-faint">
                Verified {verifiedAt.toLocaleTimeString('en-GB')} · {verifiedAt.toLocaleDateString('en-GB')}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canExport && (
            <Button size="sm" variant="secondary" loading={exporting} onClick={download}>
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          )}
          <Button
            size="sm"
            variant={result && !result.ok ? 'danger' : 'primary'}
            loading={verifying}
            onClick={verify}
            disabled={totalEvents === 0}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {result === null ? 'Verify integrity' : 'Verify again'}
          </Button>
        </div>
      </div>

      {result && !result.ok && (
        <div className="border-t border-danger-fg/30 bg-danger-bg px-5 py-3.5">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-danger-fg">
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong className="font-semibold">Event #{result.brokenAtSeq} does not verify.</strong>{' '}
              Everything before it is still provably intact; everything from that sequence number onward
              must be treated as unverified. Export the CSV now and raise this with whoever administers
              the database — the application has no code path that can rewrite a recorded event.
            </span>
          </p>
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------- filtering */

export function AuditFilters({
  actions,
  actors,
  subjects,
  total,
}: {
  /* Labels are resolved on the server: AUDIT_LABELS lives in a server-only
     module, so the mapping arrives already applied rather than re-imported. */
  actions: { action: string; label: string; n: number }[]
  actors: { id: string; name: string; n: number }[]
  subjects: { subjectType: string; n: number }[]
  total: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const [q, setQ] = React.useState(params.get('q') ?? '')

  // Every filter lives in the URL, so a filtered view can be pasted into a
  // ticket and reopened exactly as it was.
  const apply = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      next.delete('page')
      startTransition(() => router.push(`${pathname}?${next.toString()}`))
    },
    [params, pathname, router],
  )

  const active = ['action', 'actor', 'subject', 'q'].filter((k) => params.get(k))

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        className="relative min-w-[220px] flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          apply({ q: q.trim() || null })
        }}
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search summaries…"
          aria-label="Search the audit trail"
          className="h-8 py-1 pl-8 text-[13px]"
        />
      </form>

      <Select
        value={params.get('action') ?? ''}
        aria-label="Filter by action"
        className="h-8 w-52 py-1 text-[13px]"
        onChange={(e) => apply({ action: e.target.value || null })}
      >
        <option value="">Every action</option>
        {actions.map((a) => (
          <option key={a.action} value={a.action}>
            {a.label} ({a.n})
          </option>
        ))}
      </Select>

      <Select
        value={params.get('actor') ?? ''}
        aria-label="Filter by actor"
        className="h-8 w-44 py-1 text-[13px]"
        onChange={(e) => apply({ actor: e.target.value || null })}
      >
        <option value="">Anyone</option>
        {actors.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.n})
          </option>
        ))}
      </Select>

      <Select
        value={params.get('subject') ?? ''}
        aria-label="Filter by subject type"
        className="h-8 w-40 py-1 text-[13px]"
        onChange={(e) => apply({ subject: e.target.value || null })}
      >
        <option value="">Any subject</option>
        {subjects.map((s) => (
          <option key={s.subjectType} value={s.subjectType}>
            {s.subjectType.replace(/_/g, ' ')} ({s.n})
          </option>
        ))}
      </Select>

      {active.length > 0 && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setQ('')
            apply({ action: null, actor: null, subject: null, q: null })
          }}
        >
          <X className="h-3 w-3" />
          Clear
        </Button>
      )}

      <span className="tnum ml-auto flex items-center gap-2 text-2xs text-ink-faint">
        {pending && <Spinner className="h-3 w-3" />}
        {total.toLocaleString('en-GB')} event{total === 1 ? '' : 's'}
        {active.length > 0 ? ' matching' : ''}
      </span>
    </div>
  )
}

/* ----------------------------------------------------------- hash detail */

export function HashCell({ hash, prevHash }: { hash: string; prevHash: string | null }) {
  return (
    <span className="group/hash relative inline-flex items-center">
      <code className="cursor-default font-mono text-2xs text-ink-faint">{hash.slice(0, 10)}</code>
      <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 hidden w-[380px] rounded-lg border border-line bg-surface p-2.5 shadow-pop group-hover/hash:block">
        <span className="label block">This event</span>
        <code className="mt-0.5 block break-all font-mono text-2xs text-ink">{hash}</code>
        <span className="label mt-2 block">Previous</span>
        <code className="mt-0.5 block break-all font-mono text-2xs text-ink-muted">
          {prevHash ?? 'GENESIS — first event in this workspace'}
        </code>
      </span>
    </span>
  )
}

export function ActorBadge({ actorType }: { actorType: string }) {
  if (actorType === 'copilot') return <Badge tone="brand">Copilot</Badge>
  if (actorType === 'system') return <Badge tone="neutral">System</Badge>
  return null
}
