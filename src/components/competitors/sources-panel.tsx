import { Check, Minus } from 'lucide-react'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import type { ProviderStatus } from '@/lib/competitors/sources/config'

/**
 * Which outside sources are switched on, what each adds, and what happens
 * without it. The answer to "why is this simulated?" is always on this card.
 */
export function SourcesPanel({ providers }: { providers: ProviderStatus[] }) {
  const on = providers.filter((p) => p.configured).length
  return (
    <Card>
      <CardHeader
        title="Data sources"
        description={`${on} of ${providers.length} connected. Each is optional; anything missing falls back as described, and is labelled.`}
      />
      <ul className="divide-y divide-line">
        {providers.map((p) => (
          <li key={p.id} className="flex items-start gap-3 px-5 py-3">
            <span className="mt-0.5 shrink-0">
              {p.configured ? <Check className="h-4 w-4 text-ok-fg" /> : <Minus className="h-4 w-4 text-ink-faint" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-ink">{p.label}</span>
                {p.configured ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>}
              </div>
              <p className="mt-0.5 text-xs leading-snug text-ink-muted">{p.provides}</p>
              {!p.configured && (
                <p className="mt-1 text-xs leading-snug text-ink-faint">
                  Without it: {p.fallback}.{' '}
                  {p.missing.length > 0 && (
                    <>
                      Add <code className="rounded bg-bg-inset px-1 font-mono text-2xs">{p.missing.join(', ')}</code> to .env.local.
                    </>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
