/**
 * Dependency-graph scheduling for the Campaign Planner (PRD CP-4).
 *
 * Pure and framework-free on purpose: the identical arithmetic runs in the
 * browser to preview "what moves if I do this" and on the server when the
 * change is committed. A preview that disagreed with the write would be worse
 * than no preview at all.
 *
 * Dates are plain calendar days (`YYYY-MM-DD`, the `date` column type), never
 * `Date` objects, so nothing here can drift by a timezone offset.
 */

export type PlanStatus = 'not_started' | 'in_progress' | 'blocked' | 'in_review' | 'done'

export type ScheduleInput = {
  id: string
  title: string
  startDate: string | null
  dueDate: string | null
  dependsOn: string[]
  status: PlanStatus
  isMilestone: boolean
  sortIndex: number
}

/** A pending, uncommitted edit to one task. */
export type Override = {
  startDate?: string
  dueDate?: string
  status?: PlanStatus
}

export type Placement = {
  id: string
  /** Projected start / finish, in whole days since the epoch. */
  start: number
  finish: number
  /** The committed plan, for comparison. */
  baseStart: number
  baseFinish: number
  /** Days the finish moved against the committed plan. Negative means earlier. */
  shift: number
  /** The predecessor that decided this task's start, when one did. */
  driver: string | null
  cause: 'baseline' | 'dependency' | 'blocked' | 'edited'
}

export type MilestoneOutlook = {
  id: string
  title: string
  baseFinish: number
  finish: number
  /** Days late against the milestone's own committed date. */
  slip: number
  /** Driving chain, earliest predecessor first, ending at the milestone. */
  path: string[]
  /** The milestone now lands after the campaign's own end date. */
  pastCampaignEnd: boolean
}

export type Schedule = {
  placements: Map<string, Placement>
  /** Topological order. Tasks inside a dependency cycle are appended last. */
  order: string[]
  milestones: MilestoneOutlook[]
  /** Every task whose window changed against the committed plan. */
  moved: Placement[]
  /** Ids that could not be ordered because they sit in a dependency cycle. */
  cyclic: string[]
}

/* ----------------------------------------------------------- day arithmetic */

const MS_PER_DAY = 86_400_000

export function toDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / MS_PER_DAY)
}

export function fromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

export function todayDay(): number {
  return Math.floor(Date.now() / MS_PER_DAY)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Formatted by hand rather than through `Intl`, because a client component that
 * prints a date during SSR must produce the byte-identical string in Node and
 * in the browser or React reports a hydration mismatch.
 */
export function formatDay(day: number, opts: { year?: boolean } = {}): string {
  const d = new Date(day * MS_PER_DAY)
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return opts.year ? `${base} ${d.getUTCFullYear()}` : base
}

export function formatIso(iso: string | null, opts: { year?: boolean } = {}): string {
  return iso ? formatDay(toDay(iso), opts) : '—'
}

export function weekdayOf(day: number): number {
  return new Date(day * MS_PER_DAY).getUTCDay()
}

export function weekdayLabel(day: number): string {
  return WEEKDAYS[weekdayOf(day)]
}

export function monthLabel(day: number): string {
  const d = new Date(day * MS_PER_DAY)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function dayOfMonth(day: number): number {
  return new Date(day * MS_PER_DAY).getUTCDate()
}

/** Days spanned inclusive of both ends — what a person means by "3 days". */
export function spanDays(start: number, finish: number): number {
  return Math.max(1, finish - start + 1)
}

export function pluralDays(n: number): string {
  return `${n} day${Math.abs(n) === 1 ? '' : 's'}`
}

/* ------------------------------------------------------------- the schedule */

type Baseline = { start: number; finish: number }

/**
 * Walk the dependency graph and project every task's window.
 *
 * Three rules, and only three, decide where a task lands:
 *
 * 1. **Planned lag is preserved.** A generated plan deliberately overlaps work —
 *    creative starts before the brief is signed off, sign-off starts before the
 *    last asset lands. A strict finish-to-start model would declare the whole
 *    committed plan "slipped" the moment it loaded. So each edge remembers the
 *    gap it was planned with (`baseStart(successor) - baseFinish(predecessor)`,
 *    negative for planned overlap) and the constraint becomes
 *    `start >= predecessorFinish + plannedLag`. With nothing perturbed the maths
 *    reproduces the committed plan exactly; when a predecessor slips by N days,
 *    everything downstream of it moves by N.
 *
 * 2. **Finished work is history.** A `done` task keeps its recorded dates and
 *    still drives its successors, so the plan stays anchored to what happened.
 *
 * 3. **Blocked work cannot be underway.** A blocked task's start is pushed to
 *    today at the earliest — it is not being worked on, and when it unblocks it
 *    still needs its full duration. This is the lever that makes marking a task
 *    blocked ripple through the plan.
 *
 * Slipping never *pulls* work forward: `start` is floored at the planned start.
 * Finishing early creates slack, it does not silently re-plan the team's week.
 */
export function computeSchedule(
  tasks: ScheduleInput[],
  opts: {
    today: number
    overrides?: Map<string, Override>
    /** The campaign's own end date, used to flag milestones that overrun it. */
    campaignEnd?: number | null
  },
): Schedule {
  const overrides = opts.overrides ?? new Map<string, Override>()
  const byId = new Map(tasks.map((t) => [t.id, t]))

  // Baselines first: every lag below is measured against the committed plan,
  // not against the projection, so a second recalculation is a no-op.
  const base = new Map<string, Baseline>()
  for (const t of tasks) {
    const start = t.startDate ? toDay(t.startDate) : opts.today
    const finish = t.dueDate ? toDay(t.dueDate) : start
    base.set(t.id, { start, finish: Math.max(start, finish) })
  }

  const preds = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  const successors = new Map<string, string[]>()
  for (const t of tasks) {
    const list = [...new Set(t.dependsOn.filter((d) => byId.has(d) && d !== t.id))]
    preds.set(t.id, list)
    indegree.set(t.id, list.length)
    for (const p of list) successors.set(p, [...(successors.get(p) ?? []), t.id])
  }

  // Kahn, drained in sortIndex order so the result is stable run to run.
  const ordered = [...tasks].sort((a, b) => a.sortIndex - b.sortIndex || a.id.localeCompare(b.id))
  const ready = ordered.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const s of successors.get(id) ?? []) {
      const left = (indegree.get(s) ?? 0) - 1
      indegree.set(s, left)
      if (left === 0) ready.push(s)
    }
  }
  const cyclic = ordered.map((t) => t.id).filter((id) => !order.includes(id))
  // A cycle is a data fault, not a user error to punish: place those tasks at
  // their committed dates, report them, and keep the rest of the plan usable.
  order.push(...cyclic)

  const placements = new Map<string, Placement>()

  for (const id of order) {
    const task = byId.get(id)!
    const b = base.get(id)!
    const ov = overrides.get(id)
    const edited = ov?.startDate !== undefined || ov?.dueDate !== undefined
    const status = ov?.status ?? task.status

    let start = ov?.startDate ? toDay(ov.startDate) : b.start
    let duration = b.finish - b.start
    if (ov?.dueDate) duration = Math.max(0, toDay(ov.dueDate) - start)

    let driver: string | null = null
    let cause: Placement['cause'] = 'baseline'

    if (edited) {
      // The dates a person typed win outright. If they violate a dependency the
      // warning panel says so — silently overriding the typed date would be worse.
      cause = 'edited'
    } else if (status !== 'done' && !cyclic.includes(id)) {
      for (const p of preds.get(id) ?? []) {
        const placed = placements.get(p)
        if (!placed) continue
        const plannedLag = b.start - base.get(p)!.finish
        const earliest = placed.finish + plannedLag
        if (earliest > start) {
          start = earliest
          driver = p
          cause = 'dependency'
        }
      }
      if (status === 'blocked' && opts.today > start) {
        start = opts.today
        driver = null
        cause = 'blocked'
      }
    }

    const finish = start + duration
    placements.set(id, {
      id,
      start,
      finish,
      baseStart: b.start,
      baseFinish: b.finish,
      shift: finish - b.finish,
      driver,
      cause,
    })
  }

  const milestones: MilestoneOutlook[] = tasks
    .filter((t) => t.isMilestone)
    .map((t) => {
      const p = placements.get(t.id)!
      return {
        id: t.id,
        title: t.title,
        baseFinish: p.baseFinish,
        finish: p.finish,
        slip: p.finish - p.baseFinish,
        path: drivingChain(t.id, placements),
        pastCampaignEnd: opts.campaignEnd != null && p.finish > opts.campaignEnd,
      }
    })
    .sort((a, b) => b.slip - a.slip || a.finish - b.finish)

  const moved = order
    .map((id) => placements.get(id)!)
    .filter((p) => p.start !== p.baseStart || p.finish !== p.baseFinish)

  return { placements, order, milestones, moved, cyclic }
}

/**
 * The chain of predecessors that decided this task's start — the critical path
 * into it. Returned earliest-first so the UI can read it as a sentence.
 */
export function drivingChain(id: string, placements: Map<string, Placement>): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = id
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    chain.unshift(cursor)
    cursor = placements.get(cursor)?.driver ?? null
  }
  return chain
}

/* --------------------------------------------------------------- live risk */

export type TaskRisk = 'none' | 'slipping' | 'blocked' | 'overdue'

/**
 * Risk read from the projection rather than from the stored `at_risk` flag, so
 * an uncommitted preview shows the same warnings the commit will write.
 */
export function taskRisk(task: ScheduleInput, placement: Placement, today: number): TaskRisk {
  if (task.status === 'done') return 'none'
  if (task.status === 'blocked') return 'blocked'
  if (placement.finish < today) return 'overdue'
  if (placement.shift > 0) return 'slipping'
  return 'none'
}

/** One sentence a person can act on, used in previews, toasts and audit lines. */
export function summariseImpact(schedule: Schedule): string {
  const slipped = schedule.milestones.filter((m) => m.slip > 0)
  // The task the user just edited is not news to them — count the consequences.
  const moved = schedule.moved.filter((p) => p.cause !== 'edited').length
  if (moved === 0) {
    return slipped.length > 0
      ? `Nothing else moves, but "${slipped[0].title}" now lands ${pluralDays(slipped[0].slip)} late.`
      : 'Nothing else in the plan moves.'
  }

  const head = `${moved} task${moved === 1 ? '' : 's'} shift${moved === 1 ? 's' : ''}`
  if (slipped.length === 0) {
    return `${head}. Every milestone still lands on its committed date.`
  }
  const worst = slipped[0]
  const rest =
    slipped.length > 1 ? ` and ${slipped.length - 1} other milestone${slipped.length > 2 ? 's' : ''}` : ''
  return `${head}. "${worst.title}" slips ${pluralDays(worst.slip)} to ${formatDay(worst.finish)}${rest}.`
}
