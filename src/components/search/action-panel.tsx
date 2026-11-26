'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { RotateCcw, ShieldCheck, ThumbsDown, ThumbsUp, Zap } from 'lucide-react'
import { decideAction } from '@/app/actions/approvals'
import { applySearchAction, revertSearchAction } from '@/app/actions/search'
import { Badge, Button, Card, CardHeader, Textarea } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

/**
 * Deciding on, applying and reverting one PPC & SEO change, on the screen
 * that shows its evidence. Approving and applying are separate steps held by
 * different permissions, as with a paid campaign's approval and go-live.
 */
export function SearchActionPanel({
  actionId,
  status,
  simulated,
  decision,
  canApply,
}: {
  actionId: string
  status: string
  simulated: boolean
  decision: {
    requestId: string
    chainName: string
    stepName: string
    stepIndex: number
    totalSteps: number
    stepRole: string
    eligible: boolean
    canDecide: boolean
  } | null
  canApply: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [rejecting, setRejecting] = React.useState(false)

  const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string }>, okTitle: string) => {
    setBusy(key)
    try {
      const res = await fn()
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? okTitle : 'Could not do that',
        body: res.message,
      })
      if (res.ok) {
        setComment('')
        setRejecting(false)
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title={decision ? 'Your decision' : 'Status'}
        description={
          decision
            ? `${decision.chainName}, step ${decision.stepIndex + 1} of ${decision.totalSteps} (${decision.stepName})`
            : undefined
        }
        icon={<ShieldCheck className="h-4 w-4" />}
        actions={simulated ? <Badge tone="warn">Simulated data</Badge> : undefined}
      />
      <div className="space-y-3.5 p-5 text-[13px] leading-relaxed">
        {decision ? (
          !decision.canDecide ? (
            <p className="text-ink-muted">
              Your role cannot approve work. Someone with review permission needs to look at this.
            </p>
          ) : !decision.eligible ? (
            <p className="text-ink-muted">
              This step is for {decision.stepRole}s. You are not an eligible approver on it.
            </p>
          ) : (
            <>
              <p className="text-ink-muted">
                Approving does not change anything yet. It lets an owner or marketing ops apply the change,
                and the undo shown here is recorded when they do.
              </p>
              {rejecting && (
                <Textarea
                  id="search-reject-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="What needs to change? The requester sees this."
                  rows={3}
                />
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="success"
                  size="sm"
                  loading={busy === 'approve'}
                  onClick={() =>
                    run(
                      'approve',
                      () =>
                        decideAction(decision.requestId, 'approve', undefined, `/search/actions/${actionId}`),
                      'Approved',
                    )
                  }
                >
                  <ThumbsUp className="h-3.5 w-3.5" /> Approve
                </Button>
                {rejecting ? (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!comment.trim()}
                    loading={busy === 'reject'}
                    onClick={() =>
                      run(
                        'reject',
                        () =>
                          decideAction(
                            decision.requestId,
                            'reject',
                            comment.trim(),
                            `/search/actions/${actionId}`,
                          ),
                        'Changes requested',
                      )
                    }
                  >
                    <ThumbsDown className="h-3.5 w-3.5" /> Send back
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setRejecting(true)}>
                    <ThumbsDown className="h-3.5 w-3.5" /> Request changes
                  </Button>
                )}
              </div>
            </>
          )
        ) : status === 'approved' ? (
          <>
            <p className="text-ink">Approved. It has not been applied yet.</p>
            {simulated && (
              <p className="rounded-lg border border-warn-fg/25 bg-warn-bg p-3 text-ink">
                This analysis used simulated data, so applying records the change and its undo in the audit
                trail without touching Google Ads or the site.
              </p>
            )}
            {canApply ? (
              <Button
                variant="primary"
                size="sm"
                loading={busy === 'apply'}
                onClick={() => run('apply', () => applySearchAction(actionId), 'Applied')}
              >
                <Zap className="h-3.5 w-3.5" /> Apply {simulated ? '(simulated)' : 'now'}
              </Button>
            ) : (
              <p className="text-ink-muted">Only owners and marketing ops can apply search changes.</p>
            )}
          </>
        ) : status === 'applied' ? (
          <>
            <p className="text-ink">
              Applied{simulated ? ' (simulated)' : ''}. The undo is recorded in the audit trail.
            </p>
            {canApply && (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'revert'}
                onClick={() => run('revert', () => revertSearchAction(actionId), 'Reverted')}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Revert
              </Button>
            )}
          </>
        ) : status === 'changes_requested' ? (
          <p className="text-ink-muted">
            Changes were requested. Send it again from PPC &amp; SEO once it has been looked at.
          </p>
        ) : status === 'reverted' ? (
          <p className="text-ink-muted">
            Reverted. Run the analysis again before re-applying, so the evidence is current.
          </p>
        ) : (
          <p className="text-ink-muted">Not sent for approval yet.</p>
        )}
      </div>
    </Card>
  )
}
