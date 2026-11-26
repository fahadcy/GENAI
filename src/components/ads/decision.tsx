'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react'
import { decideAction } from '@/app/actions/approvals'
import { Badge, Button, Card, CardHeader, Textarea } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { budgetExplanation } from '@/lib/ads/objectives'

/**
 * Approving a paid campaign, on the campaign's own screen.
 *
 * The approvals queue deep-links a reviewer here rather than to the generic
 * review page, because a campaign cannot be judged from a single piece of
 * creative — you need the ad groups, the keywords, the targeting and above all
 * the money. Having sent them here, this is where the decision has to be
 * possible; otherwise the reviewer reads everything and then has to go back to
 * the queue to act, with none of it in front of them.
 *
 * The figure is restated in the panel itself. What is being approved is not
 * really the wording — it is the permission to spend.
 */
export function DecisionPanel({
  campaignId,
  requestId,
  chainName,
  stepName,
  stepIndex,
  totalSteps,
  eligible,
  canDecide,
  stepRole,
  dailyBudget,
  currencyCode,
  hasErrors,
}: {
  campaignId: string
  requestId: string
  chainName: string
  stepName: string
  stepIndex: number
  totalSteps: number
  /** This viewer is an approver on the step the request is currently at. */
  eligible: boolean
  /** This viewer's role can decide at all. */
  canDecide: boolean
  stepRole: string
  dailyBudget: number
  currencyCode: string
  /** Validation errors that would stop Google accepting the campaign. */
  hasErrors: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null)
  const [rejecting, setRejecting] = React.useState(false)

  const money = budgetExplanation(dailyBudget, currencyCode)

  const decide = async (decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !comment.trim()) return
    setBusy(decision)
    try {
      const result = await decideAction(
        requestId,
        decision,
        comment.trim() || undefined,
        `/ads/${campaignId}`,
      )
      toast.push({
        tone: result.ok ? 'ok' : 'danger',
        title: result.ok ? 'Decision recorded' : 'Could not record that',
        body: result.message,
      })
      if (result.ok) {
        setComment('')
        setRejecting(false)
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="border-brand-600/40">
      <CardHeader
        title="Your decision"
        description={`${chainName} — step ${stepIndex + 1} of ${totalSteps} (${stepName})`}
        icon={<ShieldCheck className="h-4 w-4" />}
        actions={<Badge tone="warn">Paid</Badge>}
      />

      <div className="space-y-3.5 p-5">
        <div className="rounded-xl border border-warn-fg/25 bg-warn-bg p-3.5">
          <p className="text-[13px] font-semibold text-warn-fg">What you are approving</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">{money.sentence}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
            Approving does not start any spending. It lets the campaign be sent to Google, where it
            arrives paused until someone turns it on.
          </p>
        </div>

        {hasErrors && (
          <p className="rounded-xl border border-danger-fg/25 bg-danger-bg p-3 text-[13px] leading-relaxed text-ink">
            This campaign still has problems that would stop Google accepting it. Approving it now is
            allowed, but it cannot be sent until they are fixed — and fixing them will send it back
            for approval again.
          </p>
        )}

        {!canDecide ? (
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Your role cannot approve work. Someone with review permission needs to look at this.
          </p>
        ) : !eligible ? (
          <p className="text-[13px] leading-relaxed text-ink-muted">
            This step is for {stepRole}s. You are not an eligible approver on it.
          </p>
        ) : rejecting ? (
          <div className="space-y-2.5">
            <Textarea
              rows={3}
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What needs changing, and why? The person who built this will only see what you write here."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={busy === 'reject'}
                disabled={!comment.trim() || busy !== null}
                onClick={() => decide('reject')}
              >
                Send it back
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => setRejecting(false)}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-ink-faint">
              A comment is required. It is recorded against the campaign and cannot be edited later.
            </p>
          </div>
        ) : (
          <>
            <Textarea
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Anything worth recording alongside your decision (optional)"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="success"
                size="md"
                loading={busy === 'approve'}
                disabled={busy !== null}
                onClick={() => decide('approve')}
              >
                <ThumbsUp className="h-4 w-4" />
                Approve
              </Button>
              <Button
                variant="ghost"
                size="md"
                disabled={busy !== null}
                onClick={() => setRejecting(true)}
              >
                <ThumbsDown className="h-4 w-4" />
                Request changes
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
