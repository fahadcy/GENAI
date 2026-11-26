'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { BookmarkCheck, Repeat2, Trash2 } from 'lucide-react'
import { Badge, Card, EmptyState } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { ChannelChip, RelativeTime } from '@/components/domain'
import { deleteTemplateAction } from '@/app/(app)/planner/actions'
import type { TemplateView } from './types'

/**
 * CP-5's library. Templates are shapes, not copies: a saved plan keeps its
 * sequence, dependencies and gates but drops absolute dates and named people,
 * which is what lets the same playbook be run again next quarter.
 */
export function TemplateGallery({
  templates,
  canManage,
}: {
  templates: TemplateView[]
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)

  if (templates.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<BookmarkCheck className="h-5 w-5" />}
          title="No saved playbooks yet"
          description="When a campaign plan works, save it from its detail page. The sequence, dependencies and approval gates are kept; the dates become offsets and the owners become roles, so the same plan lands correctly whenever it is next run."
        />
      </Card>
    )
  }

  const remove = async (id: string, name: string) => {
    setBusy(id)
    try {
      const res = await deleteTemplateAction(id)
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? `"${name}" removed` : 'Not removed',
        body: res.message,
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {templates.map((t) => (
        <Card key={t.id} className="flex flex-col p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-[13.5px] font-semibold text-ink">{t.name}</h3>
              <p className="mt-0.5 text-2xs text-ink-faint">
                saved <RelativeTime date={t.createdAt} />
                {t.usageCount > 0 && ` · used ${t.usageCount} time${t.usageCount === 1 ? '' : 's'}`}
              </p>
            </div>
            {t.usageCount > 0 ? (
              <Badge tone="brand">
                <Repeat2 className="h-3 w-3" />
                {t.usageCount}
              </Badge>
            ) : (
              <Badge tone="neutral">Unused</Badge>
            )}
          </div>

          <p className="mt-2 line-clamp-2 min-h-[2.4em] text-[13px] leading-snug text-ink-muted">
            {t.description ??
              `${t.taskCount} tasks across ${t.phaseCount} phases over ${t.durationDays} days.`}
          </p>

          <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3">
            <Figure label="Tasks" value={t.taskCount} />
            <Figure label="Phases" value={t.phaseCount} />
            <Figure label="Days" value={t.durationDays} />
          </dl>

          {t.channels.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {t.channels.map((c) => (
                <ChannelChip key={c} channel={c} size="sm" />
              ))}
            </div>
          )}

          <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-2xs text-ink-faint">
            <span>Pick it up from the composer above.</span>
            {canManage && (
              <button
                type="button"
                onClick={() => void remove(t.id, t.name)}
                disabled={busy === t.id}
                className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg disabled:opacity-50"
                aria-label={`Delete the ${t.name} template`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="tnum mt-0.5 text-[15px] font-semibold leading-none text-ink">{value}</dd>
    </div>
  )
}
