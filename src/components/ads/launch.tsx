'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Check,
  Clock,
  Info,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, Card, CardHeader, LinkButton } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { formatMoney } from '@/components/domain'
import { budgetExplanation } from '@/lib/ads/objectives'
import { ROLE_LABEL } from '@/lib/auth/rbac'
import {
  dryRunAction,
  pushCampaignAction,
  setLiveAction,
  submitCampaignAction,
} from '@/app/actions/ads'
import type { AdCampaignStatus, ApprovalStep, Role } from '@/lib/db/schema'

export type LaunchApproval = {
  chainName: string
  steps: ApprovalStep[]
  currentStep: number
} | null

type Problem = { where: string; message: string; fix: string }

type Outcome = {
  ok: boolean
  message: string
  simulated?: boolean
  problems?: Problem[]
}

/**
 * The actions' failure branch carries no `data` in its type, but a dry run puts
 * the list of problems on exactly that branch — which is the case the user most
 * needs to see. Read it off the result rather than throwing it away.
 */
/**
 * Normalises every action result to one shape. `data` differs per action, so
 * this reads the two fields the panel cares about when they are there and
 * ignores the rest — a submit returns a chain and a step, a push returns
 * problems, and the panel renders both through the same path.
 */
function outcomeOf(result: {
  ok: boolean
  message: string
  data?: { problems?: Problem[]; simulated?: boolean } | Record<string, unknown>
}): Outcome {
  const data = result.data as { problems?: Problem[]; simulated?: boolean } | undefined
  return {
    ok: result.ok,
    message: result.message,
    simulated: data?.simulated,
    problems: data?.problems,
  }
}

type Props = {
  campaign: {
    id: string
    status: AdCampaignStatus
    currencyCode: string
    dailyBudget: number
    externalCampaignId: string | null
    lastError: string | null
  }
  /** Non-null when something would stop this reaching Google right now. */
  blockReason: string | null
  approval: LaunchApproval
  account: { name: string; connected: boolean; testAccount: boolean } | null
  permissions: { create: boolean; push: boolean; golive: boolean }
}

/**
 * The one control on this screen that can commit money.
 *
 * Two rules shape it. It offers exactly one action — whichever is correct for
 * the campaign's current state — because a row of buttons where three are
 * disabled invites someone to work out which one to force. And the step from
 * "paused in Google" to "spending" is never a single click: the figures are put
 * in front of the person, and they have to say yes to the figures, not to a
 * button.
 */
export function LaunchPanel({ campaign, blockReason, approval, account, permissions }: Props) {
  const router = useRouter()
  const { push } = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)

  const money = budgetExplanation(campaign.dailyBudget, campaign.currencyCode)

  const run = async (key: string, fn: () => Promise<Outcome>) => {
    setBusy(key)
    setOutcome(null)
    try {
      const result = await fn()
      setOutcome(result)
      push({
        tone: result.ok ? 'ok' : 'danger',
        title: result.ok ? 'Done' : 'Not done',
        body: result.message,
      })
      if (result.ok) router.refresh()
      return result
    } finally {
      setBusy(null)
    }
  }

  const status = campaign.status
  const draftLike = status === 'draft' || status === 'changes_requested'

  return (
    <Card>
      <CardHeader
        title={HEADING[status]}
        description={SUBHEADING[status]}
        icon={<ShieldCheck className="h-4 w-4" />}
      />

      <div className="space-y-3.5 p-5">
        {account === null && (
          <Note tone="warn">
            This campaign is not linked to a Google Ads account yet. Choose one before sending it —
            without an account there is nowhere for it to go.
          </Note>
        )}
        {account !== null && !account.connected && !campaign.externalCampaignId && (
          <Note tone="warn">
            Google Ads is not connected to this workspace, so anything sent from here is built and
            checked by this platform and goes no further. Nothing reaches a real account, and
            nothing can spend.
          </Note>
        )}
        {account !== null && !account.connected && campaign.externalCampaignId && (
          <Note tone="warn">
            This campaign never actually reached Google — the account is not connected, so it was
            built and checked here instead. Nothing below changes anything in a real Google Ads
            account until an account is connected.
          </Note>
        )}
        {account?.testAccount && (
          <Note tone="info">
            {account.name} is a Google test account. Campaigns created in it never run and never
            spend.
          </Note>
        )}

        {/* ------------------------------------------------- draft / rejected */}
        {draftLike && (
          <>
            {status === 'changes_requested' && (
              <Note tone="danger">
                A reviewer sent this back. Make the changes they asked for, then send it again.
              </Note>
            )}
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Nothing exists in Google yet and nothing can spend. The next step is a review by
              someone else — a campaign cannot be approved by the person who wrote it.
            </p>
            <Button
              variant="secondary"
              size="md"
              className="w-full"
              loading={busy === 'dryrun'}
              disabled={busy !== null}
              onClick={() =>
                run('dryrun', async () => outcomeOf(await dryRunAction(campaign.id)))
              }
            >
              <Check className="h-4 w-4" />
              Check it with Google
            </Button>
            <p className="text-xs leading-relaxed text-ink-faint">
              Sends the campaign to Google to be checked and creates nothing. It is the cheapest way
              to find out that a headline is two characters too long.
            </p>
            {permissions.create ? (
              <Button
                variant="primary"
                size="md"
                className="w-full"
                loading={busy === 'submit'}
                disabled={busy !== null}
                onClick={() =>
                  run('submit', async () => outcomeOf(await submitCampaignAction(campaign.id)))
                }
              >
                <Send className="h-4 w-4" />
                Send for approval
              </Button>
            ) : (
              <Note tone="neutral">Your role cannot submit campaigns for approval.</Note>
            )}
          </>
        )}

        {/* ------------------------------------------------------- in review */}
        {status === 'in_review' && <WaitingOnApproval approval={approval} />}

        {/* -------------------------------------------------------- approved */}
        {status === 'approved' && (
          <>
            <Note tone="ok">
              Creating this in Google does not spend anything. The campaign arrives paused, and stays
              paused until someone turns it on here.
            </Note>
            {blockReason && <Note tone="danger">{blockReason}</Note>}
            {permissions.push ? (
              <Button
                variant="primary"
                size="md"
                className="w-full"
                loading={busy === 'push'}
                disabled={busy !== null || blockReason !== null}
                onClick={() =>
                  run('push', async () => outcomeOf(await pushCampaignAction(campaign.id)))
                }
              >
                <ArrowRight className="h-4 w-4" />
                Send to Google
              </Button>
            ) : (
              <Note tone="neutral">Your role cannot send campaigns to Google.</Note>
            )}
          </>
        )}

        {/* ------------------------------------------------------ publishing */}
        {status === 'publishing' && (
          <Note tone="info">
            Being created in Google now. This takes a few seconds — reload the page to see where it
            got to.
          </Note>
        )}

        {/* ---------------------------------------------------------- paused */}
        {status === 'paused' && (
          <GoLive
            campaign={campaign}
            canGoLive={permissions.golive}
            busy={busy}
            onGoLive={(ceiling) =>
              run('golive', async () =>
                outcomeOf(
                  await setLiveAction({
                    id: campaign.id,
                    live: true,
                    acknowledgedMonthlyCeiling: ceiling,
                  }),
                ),
              )
            }
          />
        )}

        {/* ------------------------------------------------------------ live */}
        {status === 'live' && (
          <>
            <div className="rounded-xl border border-warn-fg/25 bg-warn-bg p-4">
              <p className="text-2xs font-semibold uppercase tracking-wider text-warn-fg">
                Spending now
              </p>
              <p className="tnum mt-1 text-2xl font-semibold leading-none tracking-tight text-ink">
                {formatMoney(campaign.dailyBudget, campaign.currencyCode)}
                <span className="ml-1.5 text-sm font-medium text-ink-muted">a day, on average</span>
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink">{money.sentence}</p>
            </div>
            {permissions.golive ? (
              <>
                <Button
                  variant="danger"
                  size="md"
                  className="w-full"
                  loading={busy === 'pause'}
                  disabled={busy !== null}
                  onClick={() =>
                    run('pause', async () =>
                      outcomeOf(await setLiveAction({ id: campaign.id, live: false })),
                    )
                  }
                >
                  <Pause className="h-4 w-4" />
                  Pause — stop spending
                </Button>
                <p className="text-xs leading-relaxed text-ink-faint">
                  Pausing takes effect immediately. Everything built here stays in Google, so it can
                  be turned back on later without being rebuilt.
                </p>
              </>
            ) : (
              <Note tone="neutral">
                Only an owner or marketing ops can pause a campaign. Ask one of them if this needs to
                stop now.
              </Note>
            )}
          </>
        )}

        {/* ---------------------------------------------------------- failed */}
        {status === 'failed' && (
          <>
            <Note tone="danger">
              {campaign.lastError ?? 'Google refused the campaign and did not say why.'}
            </Note>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Google accepts or rejects the whole campaign at once, so nothing was half-created.
              Fixing the problem above and sending again is safe.
            </p>
            {permissions.push && (
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                loading={busy === 'push'}
                disabled={busy !== null}
                onClick={() =>
                  run('push', async () => outcomeOf(await pushCampaignAction(campaign.id)))
                }
              >
                <RefreshCw className="h-4 w-4" />
                Try sending it again
              </Button>
            )}
          </>
        )}

        {/* ----------------------------------------------------------- ended */}
        {status === 'ended' && (
          <Note tone="neutral">
            This campaign has finished and is no longer spending. The record of what ran is kept
            below.
          </Note>
        )}

        {outcome && <OutcomePanel outcome={outcome} />}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------- go live */

/**
 * `acknowledgedMonthlyCeiling` is the figure this component displayed, not one
 * recomputed at click time. The action compares it with the campaign's real
 * budget and refuses if they have drifted apart — which is exactly the case
 * where someone edited the budget in another tab while this panel was open.
 */
function GoLive({
  campaign,
  canGoLive,
  busy,
  onGoLive,
}: {
  campaign: Props['campaign']
  canGoLive: boolean
  busy: string | null
  onGoLive: (ceiling: number) => Promise<Outcome>
}) {
  const [armed, setArmed] = React.useState(false)
  const [acknowledged, setAcknowledged] = React.useState(false)

  const money = budgetExplanation(campaign.dailyBudget, campaign.currencyCode)
  const ceiling = Math.round(money.monthlyMax)

  if (!campaign.externalCampaignId) {
    return (
      <Note tone="warn">
        This campaign is marked as paused but has no record of ever reaching Google, so there is
        nothing to turn on. Send it to Google first.
      </Note>
    )
  }

  if (!canGoLive) {
    return (
      <>
        <Note tone="info">
          The campaign is in Google and paused. Nothing is spending.
        </Note>
        <Note tone="neutral">
          Only an owner or marketing ops can turn a campaign on. Your role can read everything here
          and check the plan, but not start the spend.
        </Note>
      </>
    )
  }

  if (!armed) {
    return (
      <>
        <Note tone="info">
          The campaign is in Google and paused. Nothing is spending, and nobody has seen the ads.
        </Note>
        <Button variant="gold" size="lg" className="w-full" onClick={() => setArmed(true)}>
          <Play className="h-4 w-4" />
          Turn it on
        </Button>
        <p className="text-xs leading-relaxed text-ink-faint">
          You will see exactly what it can cost before anything starts.
        </p>
      </>
    )
  }

  return (
    <div className="rounded-xl border border-warn-fg/30 bg-warn-bg p-4">
      <p className="flex items-center gap-2 text-[13.5px] font-semibold text-warn-fg">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        This starts spending real money
      </p>

      <dl className="mt-3 space-y-2 border-y border-warn-fg/20 py-3">
        <Figure
          label="Every day, on average"
          value={formatMoney(campaign.dailyBudget, campaign.currencyCode)}
        />
        <Figure
          label="On a busy day, up to"
          value={formatMoney(money.dailyMax, campaign.currencyCode)}
        />
        <Figure
          label="In a month, up to"
          value={formatMoney(money.monthlyMax, campaign.currencyCode)}
          strong
        />
      </dl>

      <p className="mt-3 text-[13px] leading-relaxed text-ink">
        A daily budget is not a daily cap. {money.sentence}
      </p>

      <label className="mt-3.5 flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-ink">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-current text-warn-fg"
        />
        <span>
          I understand this can spend up to{' '}
          <strong className="font-semibold">
            {formatMoney(money.monthlyMax, campaign.currencyCode)}
          </strong>{' '}
          a month.
        </span>
      </label>

      <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
        <Button
          variant="danger"
          size="md"
          className="w-full sm:flex-1"
          disabled={!acknowledged || busy !== null}
          loading={busy === 'golive'}
          onClick={async () => {
            const result = await onGoLive(ceiling)
            if (result.ok) {
              setArmed(false)
              setAcknowledged(false)
            }
          }}
        >
          <Play className="h-4 w-4" />
          Start spending
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="w-full sm:w-auto"
          disabled={busy !== null}
          onClick={() => {
            setArmed(false)
            setAcknowledged(false)
          }}
        >
          Not yet
        </Button>
      </div>

      <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
        Google reviews the ads first, so they usually start showing within a few hours. You can pause
        it again at any time and spending stops immediately.
      </p>
    </div>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 text-[13px] text-ink-muted">{label}</dt>
      <dd
        className={cn(
          'tnum shrink-0 font-semibold text-ink',
          strong ? 'text-[17px]' : 'text-[15px]',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------ in review */

function WaitingOnApproval({ approval }: { approval: LaunchApproval }) {
  if (!approval) {
    return (
      <Note tone="warn">
        This campaign is waiting for approval, but the request is no longer on record. Send it again
        to restart the review.
      </Note>
    )
  }

  const step = approval.steps[approval.currentStep]
  const roleLabel = step ? (ROLE_LABEL[step.role as Role] ?? step.role) : null

  return (
    <>
      <div className="rounded-xl bg-bg-subtle p-4">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
          <Clock className="h-4 w-4 shrink-0 text-warn-fg" />
          Waiting on {step?.name ?? 'a reviewer'}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          It is with the &ldquo;{approval.chainName}&rdquo; review, step {approval.currentStep + 1} of{' '}
          {approval.steps.length}.{' '}
          {roleLabel
            ? `Anyone with the ${roleLabel} role can sign this step off.`
            : 'The named approvers on this step can sign it off.'}
        </p>
      </div>
      <ol className="space-y-1.5">
        {approval.steps.map((s, i) => {
          const done = i < approval.currentStep
          const active = i === approval.currentStep
          return (
            <li
              key={i}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2',
                active ? 'bg-brand-50' : 'bg-bg-subtle',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-bold',
                  done
                    ? 'bg-ok-fg text-ink-invert'
                    : active
                      ? 'bg-brand-solid text-brand-on'
                      : 'bg-bg-inset text-ink-faint',
                )}
              >
                {done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                {s.name}
              </span>
              <span className="shrink-0 text-2xs text-ink-faint">
                {ROLE_LABEL[s.role as Role] ?? s.role}
              </span>
            </li>
          )
        })}
      </ol>
      <LinkButton href="/approvals" variant="secondary" size="md" className="w-full">
        Open the approvals queue
      </LinkButton>
      <p className="text-xs leading-relaxed text-ink-faint">
        Nothing can be sent to Google while a review is open. If the plan is edited it goes back to
        draft, because an approval only covers the version it was given.
      </p>
    </>
  )
}

/* --------------------------------------------------------------- result */

function OutcomePanel({ outcome }: { outcome: Outcome }) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3.5',
        outcome.ok ? 'border-ok-fg/25 bg-ok-bg' : 'border-danger-fg/25 bg-danger-bg',
      )}
    >
      <p
        className={cn(
          'text-[13px] font-semibold leading-relaxed',
          outcome.ok ? 'text-ok-fg' : 'text-danger-fg',
        )}
      >
        {outcome.message}
      </p>

      {outcome.simulated && (
        /* Stated separately from the message, because a simulated success that
           reads like a real one is the most expensive misunderstanding this
           screen could cause. */
        <p className="mt-2 rounded-lg bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink">
          <span className="font-semibold">Nothing was sent to Google.</span> The campaign was built
          and checked here because Google Ads is not connected to this workspace yet. Connect an
          account and do this again to make it real.
        </p>
      )}

      {(outcome.problems?.length ?? 0) > 0 && (
        <ul className="mt-2.5 space-y-2">
          {outcome.problems?.map((p, i) => (
            <li key={i} className="rounded-lg bg-surface px-3 py-2">
              <p className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                {p.where}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink">{p.message}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{p.fix}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- bits */

function Note({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral'
  children: React.ReactNode
}) {
  const Icon =
    tone === 'ok' ? Check : tone === 'danger' ? AlertOctagon : tone === 'warn' ? AlertTriangle : Info
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-xl border p-3.5 text-[13px] leading-relaxed',
        tone === 'ok' && 'border-ok-fg/25 bg-ok-bg text-ink',
        tone === 'warn' && 'border-warn-fg/25 bg-warn-bg text-ink',
        tone === 'danger' && 'border-danger-fg/25 bg-danger-bg text-ink',
        tone === 'info' && 'border-info-fg/25 bg-info-bg text-ink',
        tone === 'neutral' && 'border-line bg-bg-subtle text-ink-muted',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          tone === 'ok' && 'text-ok-fg',
          tone === 'warn' && 'text-warn-fg',
          tone === 'danger' && 'text-danger-fg',
          tone === 'info' && 'text-info-fg',
          tone === 'neutral' && 'text-ink-faint',
        )}
        aria-hidden
      />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/* Kept short: these are card titles in a 380px rail, and CardHeader truncates
   rather than wraps, so a terse heading beats a clipped one. */
const HEADING: Record<AdCampaignStatus, string> = {
  draft: 'Before it can spend',
  in_review: 'With a reviewer',
  changes_requested: 'Sent back',
  approved: 'Ready for Google',
  publishing: 'Being created',
  live: 'Spending now',
  paused: 'Not spending yet',
  ended: 'Finished',
  failed: 'Google refused it',
}

const SUBHEADING: Record<AdCampaignStatus, string> = {
  draft: 'Three steps: check it, get it approved, then turn it on.',
  in_review: 'Somebody else has to agree before this can reach Google.',
  changes_requested: 'Fix what the reviewer raised and send it back.',
  approved: 'Creating it in Google costs nothing. It arrives paused.',
  publishing: 'The whole campaign is created in one go, or not at all.',
  live: 'Money is going out now. Pausing stops it immediately.',
  paused: 'It exists in Google. Nobody has seen the ads and nothing has been charged.',
  ended: 'No longer running.',
  failed: 'Nothing was half-created — Google rejects the whole campaign or none of it.',
}
