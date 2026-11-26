'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CopyPlus } from 'lucide-react'
import { buildLookalikeAction } from '@/app/actions/targeting'
import { Button, Card, CardHeader } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

/**
 * AT-2. The threshold is the only knob, and its meaning is spelled out: the
 * similarity score is a weighted blend of company size, engagement, industry
 * and country against the seed's centroid, so a marketer can reason about
 * which way to move it.
 */
export function LookalikeBuilder({
  seedSegmentId,
  seedName,
  seedSize,
  canCreate,
}: {
  seedSegmentId: string
  seedName: string
  seedSize: number
  canCreate: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [threshold, setThreshold] = React.useState(0.75)
  const [busy, setBusy] = React.useState(false)

  const build = async () => {
    setBusy(true)
    try {
      const res = await buildLookalikeAction(seedSegmentId, threshold)
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Lookalike built' : 'Nothing cleared the threshold',
        body: res.message,
      })
      if (res.ok && res.data) router.push(`/targeting/${res.data.id}`)
    } catch {
      // A server-side failure part-way through leaves a segment with no
      // members, so say so rather than letting the click silently do nothing.
      toast.push({
        tone: 'danger',
        title: 'Lookalike build failed',
        body: 'The expansion did not finish. Check the segment list before retrying — a half-built segment may need deleting.',
      })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const band =
    threshold >= 0.85
      ? { label: 'Tight', note: 'Very close matches only. Expect a small, high-intent audience.' }
      : threshold >= 0.7
        ? { label: 'Balanced', note: 'The usual starting point — recognisably similar, still worth reaching.' }
        : { label: 'Broad', note: 'Loose resemblance. Good for prospecting, weaker per-contact intent.' }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Build a lookalike"
        description={`Scores every non-suppressed contact outside this segment against the profile of its ${seedSize.toLocaleString('en-GB')} members.`}
        icon={<CopyPlus className="h-4 w-4" />}
      />
      <div className="space-y-3 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="label">Similarity threshold</span>
          <span className="tnum text-lg font-semibold tracking-tight text-ink">
            {threshold.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={0.95}
          step={0.01}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          aria-label="Similarity threshold"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-inset accent-brand-600"
        />
        <div className="flex justify-between text-2xs text-ink-faint">
          <span>0.50 broad</span>
          <span>0.95 tight</span>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">{band.label}.</span> {band.note}
        </p>
        <p className="text-xs leading-relaxed text-ink-faint">
          Similarity weights company size 30%, engagement 30%, industry 25% and country 15%. Suppressed
          contacts are excluded from the candidate pool before scoring.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={build}
          loading={busy}
          disabled={!canCreate || seedSize === 0}
          title={
            !canCreate
              ? 'Your role cannot create segments'
              : seedSize === 0
                ? 'The seed segment has no members to learn from'
                : undefined
          }
        >
          Build lookalike from “{seedName}”
        </Button>
        {seedSize === 0 && (
          <p className="text-xs text-ink-faint">
            Refresh this segment first — a lookalike needs members to learn a profile from.
          </p>
        )}
      </div>
    </Card>
  )
}
