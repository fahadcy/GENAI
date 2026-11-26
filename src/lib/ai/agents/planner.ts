import 'server-only'
import { z } from 'zod'
import { run, seededRandom } from '../gateway'

/**
 * Campaign planning agent (PRD CP-1). Objective in, sequenced plan out —
 * phases, tasks, owners by role, channels, offsets and dependencies.
 * Dates are produced as day offsets so the plan can be re-anchored when the
 * start date moves (CP-4).
 */

const taskSchema = z.object({
  ref: z.string(), // local id used for dependency wiring, e.g. "t3"
  phase: z.string(),
  title: z.string(),
  description: z.string().optional(),
  channel: z.string().nullable().optional(),
  ownerRole: z.string(),
  startOffsetDays: z.number().int().min(0),
  durationDays: z.number().int().min(1).max(60),
  dependsOn: z.array(z.string()).default([]),
  isMilestone: z.boolean().default(false),
  needsApproval: z.boolean().default(false),
})

const planSchema = z.object({
  summary: z.string(),
  phases: z.array(z.string()).min(2),
  tasks: z.array(taskSchema).min(4),
  risks: z.array(z.string()).default([]),
  recommendedChannels: z.array(z.string()).default([]),
})

export type GeneratedPlan = z.infer<typeof planSchema>

export async function generatePlan(args: {
  workspaceId: string
  userId?: string | null
  campaignId: string
  name: string
  objective: string
  channels: string[]
  durationDays: number
  budget: number
  currency: string
}): Promise<{ plan: GeneratedPlan; simulated: boolean }> {
  const system = [
    'You are a campaign planning strategist. You produce plans a team can execute without asking follow-up questions.',
    'Sequence realistically: research and audience work before creative, creative before approval, approval before launch, measurement after.',
    'Every task gets an ownerRole from: strategist, creator, approver, admin, analyst.',
    'Mark the go-live task isMilestone true. Mark tasks that produce publishable work needsApproval true.',
    'startOffsetDays counts from campaign start. dependsOn references other tasks by their ref.',
    'Return JSON matching: { summary, phases[], tasks[{ref,phase,title,description,channel,ownerRole,startOffsetDays,durationDays,dependsOn[],isMilestone,needsApproval}], risks[], recommendedChannels[] }',
  ].join('\n')

  const prompt = [
    `CAMPAIGN: ${args.name}`,
    `OBJECTIVE: ${args.objective}`,
    `CHANNELS: ${args.channels.join(', ') || 'choose appropriate channels'}`,
    `WINDOW: ${args.durationDays} days`,
    `BUDGET: ${args.currency} ${args.budget.toLocaleString()}`,
    '',
    `Produce between 8 and 16 tasks across 3-5 phases. Keep the critical path inside ${args.durationDays} days.`,
  ].join('\n')

  const result = await run({
    agent: 'campaign.plan',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: planSchema,
    tier: 'smart',
    temperature: 0.6,
    subject: { type: 'campaign', id: args.campaignId },
    simulate: () => simulatePlan(args),
  })

  return { plan: result.data, simulated: result.meta.simulated }
}

export function simulatePlan(args: {
  campaignId: string
  name: string
  objective: string
  channels: string[]
  durationDays: number
}): GeneratedPlan {
  const rng = seededRandom(args.campaignId)
  const d = Math.max(14, args.durationDays)
  const chans = args.channels.length ? args.channels : ['email', 'linkedin', 'google_ads']
  const scale = (frac: number) => Math.max(0, Math.round(d * frac))

  const tasks: z.infer<typeof taskSchema>[] = [
    {
      ref: 't1',
      phase: 'Foundation',
      title: 'Define the audience and success measure',
      description: `Agree who this is for and the single number that says it worked. Objective: ${args.objective}`,
      channel: null,
      ownerRole: 'strategist',
      startOffsetDays: 0,
      durationDays: 2,
      dependsOn: [],
      isMilestone: false,
      needsApproval: false,
    },
    {
      ref: 't2',
      phase: 'Foundation',
      title: 'Build and validate the target segment',
      description: 'Describe the audience in plain language, review the interpreted rules, confirm reachability by channel.',
      channel: null,
      ownerRole: 'strategist',
      startOffsetDays: 1,
      durationDays: 2,
      dependsOn: ['t1'],
      isMilestone: false,
      needsApproval: false,
    },
    {
      ref: 't3',
      phase: 'Foundation',
      title: 'Write the creative brief',
      description: 'Objective, audience, key messages, must-include and must-avoid.',
      channel: null,
      ownerRole: 'strategist',
      startOffsetDays: 2,
      durationDays: 1,
      dependsOn: ['t1'],
      isMilestone: false,
      needsApproval: false,
    },
  ]

  let ref = 4
  const creativeRefs: string[] = []
  chans.forEach((c, i) => {
    const r = `t${ref++}`
    creativeRefs.push(r)
    tasks.push({
      ref: r,
      phase: 'Creative',
      title: `Generate ${labelFor(c)} assets`,
      description: `Produce on-brand variants for ${labelFor(c)} from the brief and score them against the brand profile.`,
      channel: c,
      ownerRole: 'creator',
      startOffsetDays: scale(0.2) + i,
      durationDays: 3,
      dependsOn: ['t3'],
      isMilestone: false,
      needsApproval: true,
    })
  })

  const reviewRef = `t${ref++}`
  tasks.push({
    ref: reviewRef,
    phase: 'Governance',
    title: 'Brand and legal sign-off',
    description: 'Route every asset through its approval chain. Nothing schedules until its gate passes.',
    channel: null,
    ownerRole: 'approver',
    startOffsetDays: scale(0.42),
    durationDays: 2,
    dependsOn: creativeRefs,
    isMilestone: false,
    needsApproval: false,
  })

  const scheduleRef = `t${ref++}`
  tasks.push({
    ref: scheduleRef,
    phase: 'Launch',
    title: 'Schedule across channels at predicted best times',
    description: 'Place approved assets on the calendar using send-time optimisation; check blackout windows and frequency caps.',
    channel: null,
    ownerRole: 'strategist',
    startOffsetDays: scale(0.52),
    durationDays: 2,
    dependsOn: [reviewRef],
    isMilestone: false,
    needsApproval: false,
  })

  const liveRef = `t${ref++}`
  tasks.push({
    ref: liveRef,
    phase: 'Launch',
    title: 'Go live',
    description: 'First sends and posts publish. Confirm delivery on every channel.',
    channel: null,
    ownerRole: 'admin',
    startOffsetDays: scale(0.6),
    durationDays: 1,
    dependsOn: [scheduleRef],
    isMilestone: true,
    needsApproval: false,
  })

  tasks.push(
    {
      ref: `t${ref++}`,
      phase: 'Optimise',
      title: 'Mid-flight review and budget reallocation',
      description: 'Read the channel scorecard, retire fatiguing creative, move spend toward what converts.',
      channel: null,
      ownerRole: 'analyst',
      startOffsetDays: scale(0.75),
      durationDays: 2,
      dependsOn: [liveRef],
      isMilestone: false,
      needsApproval: false,
    },
    {
      ref: `t${ref++}`,
      phase: 'Optimise',
      title: 'Refresh the lowest-performing creative',
      description: 'Regenerate replacements for fatiguing assets and re-run them through approval.',
      channel: chans[0] ?? null,
      ownerRole: 'creator',
      startOffsetDays: scale(0.8),
      durationDays: 3,
      dependsOn: [liveRef],
      isMilestone: false,
      needsApproval: true,
    },
    {
      ref: `t${ref++}`,
      phase: 'Optimise',
      title: 'Results readout',
      description: 'Attribute lift to campaign, asset and decision. Feed the outcome back into the next brief.',
      channel: null,
      ownerRole: 'analyst',
      startOffsetDays: Math.max(scale(0.95), d - 2),
      durationDays: 2,
      dependsOn: [liveRef],
      isMilestone: false,
      needsApproval: false,
    },
  )

  return {
    summary: `A ${d}-day ${chans.length}-channel campaign: build the audience and brief first, generate and govern the creative, launch at predicted best send times, then optimise mid-flight against the ${'signups'} goal.`,
    phases: ['Foundation', 'Creative', 'Governance', 'Launch', 'Optimise'],
    tasks,
    risks: [
      'Approval sits on one reviewer — add a parallel approver so absence does not block launch.',
      `Creative production for ${chans.length} channels overlaps sign-off; slippage here moves go-live directly.`,
      rng() > 0.5
        ? 'Audience reachability on paid channels is unverified until the segment syncs.'
        : 'Budget is concentrated in one channel; no reallocation headroom if it underperforms.',
    ],
    recommendedChannels: chans,
  }
}

function labelFor(channel: string): string {
  const map: Record<string, string> = {
    email: 'email',
    linkedin: 'LinkedIn',
    x: 'X',
    instagram: 'Instagram',
    facebook: 'Facebook',
    blog: 'blog',
    google_ads: 'Google Ads',
    meta_ads: 'Meta Ads',
    sms: 'SMS',
    push: 'push',
    web: 'web',
  }
  return map[channel] ?? channel
}
