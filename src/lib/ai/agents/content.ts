import 'server-only'
import { z } from 'zod'
import { pick, run, seededRandom } from '../gateway'
import { TONE_AXES } from '../guardrails'
import type { AssetBody, Brief, BrandProfile } from '@/lib/db/schema'

/**
 * Content agent (PRD CS-1). One brief in, channel-shaped variants out.
 * The prompt carries the brand profile so voice is enforced at generation time,
 * not only caught afterwards by the guardrail.
 */

const bodySchema = z.object({
  subject: z.string().optional(),
  preheader: z.string().optional(),
  headline: z.string().optional(),
  body: z.string().min(1),
  cta: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  altText: z.string().optional(),
})

const variantSchema = z.object({
  channel: z.string(),
  variantLabel: z.string(),
  /** Short internal name, e.g. "Cost-of-delay angle". */
  title: z.string(),
  angle: z.string(),
  body: bodySchema,
  imagePrompt: z.string().optional(),
})

const outputSchema = z.object({ variants: z.array(variantSchema).min(1) })

export type GeneratedVariant = z.infer<typeof variantSchema>

const CHANNEL_GUIDE: Record<string, string> = {
  email:
    'Email. Give subject (max 55 chars, no clickbait), preheader (max 100 chars), body of 90-160 words in 3-4 short paragraphs, and a cta of 2-5 words. No hashtags.',
  linkedin:
    'LinkedIn post. 90-150 words. Open with a concrete observation, not a question. Short lines. 2-3 hashtags. No subject or preheader.',
  x: 'X post. Body must be under 265 characters. One clear idea. At most 1 hashtag.',
  instagram:
    'Instagram caption. 60-120 words, warm and visual. 4-6 hashtags. Include altText describing the intended image.',
  facebook: 'Facebook post. 60-110 words, conversational. 0-2 hashtags.',
  blog:
    'Blog intro section. headline (max 65 chars) plus 150-220 words that set up the problem and promise the payoff. cta at the end.',
  google_ads:
    'Google responsive search ad. headline max 30 chars, body (description) max 90 chars. Direct, benefit-led, include a number if credible.',
  meta_ads: 'Meta ad. headline max 40 chars, body (primary text) max 125 chars. Hook in the first 5 words.',
  sms: 'SMS. body under 155 characters including the CTA. Plain, no emoji unless the brand is playful.',
  push: 'Push notification. headline max 45 chars, body max 140 chars. Immediate and specific.',
  web: 'Website section. headline plus 70-120 words and a cta.',
}

function brandBlock(p: BrandProfile): string {
  const tone = TONE_AXES.map((axis) => `${axis} ${p.tone[axis]}/100`).join(', ')
  return [
    `BRAND VOICE: ${p.voice || 'Clear, credible, human.'}`,
    `TONE TARGETS: ${tone}`,
    p.doList.length ? `ALWAYS: ${p.doList.join(' | ')}` : '',
    p.dontList.length ? `NEVER: ${p.dontList.join(' | ')}` : '',
    p.bannedTerms.length ? `BANNED WORDS (must not appear): ${p.bannedTerms.join(', ')}` : '',
    p.preferredTerms.length
      ? `PREFERRED WORDING: ${p.preferredTerms.map((t) => `say "${t.use}" not "${t.avoid}"`).join('; ')}`
      : '',
    `READING LEVEL: keep below US grade ${p.readingLevelMax}.`,
    `PUNCTUATION: at most ${p.maxExclamations} exclamation mark(s) in total.`,
  ]
    .filter(Boolean)
    .join('\n')
}

export async function generateVariants(args: {
  workspaceId: string
  userId?: string | null
  brief: Pick<
    Brief,
    | 'id'
    | 'title'
    | 'objective'
    | 'audienceNote'
    | 'keyMessages'
    | 'channels'
    | 'callToAction'
    | 'mustInclude'
    | 'mustAvoid'
    | 'variantsPerChannel'
  >
  profile: BrandProfile
  /** Optional: regenerate a single channel only. */
  onlyChannel?: string
  /** Extra steer from the user, e.g. "make it shorter and less formal". */
  instruction?: string
  /** Competitive context from Competitors, already cut to a prompt block. */
  competitiveContext?: string | null
}): Promise<{ variants: GeneratedVariant[]; simulated: boolean; latencyMs: number; costUsd: number }> {
  const { brief, profile } = args
  const channels = args.onlyChannel ? [args.onlyChannel] : brief.channels
  const n = Math.max(1, Math.min(4, brief.variantsPerChannel))

  const system = [
    'You are a senior marketing copywriter. You write assets that ship — specific, concrete and on-brand.',
    'Rules: no filler openers ("In today\'s fast-paced world"), no invented statistics, no claims the brief does not support.',
    'Each variant for a channel must take a genuinely different angle, not reword the same one.',
    '',
    brandBlock(profile),
    '',
    'Return JSON: { "variants": [ { "channel", "variantLabel", "title", "angle", "body": { ... }, "imagePrompt" } ] }',
    'variantLabel is "A", "B", "C"… per channel. title is a 2-5 word internal name for the angle.',
  ].join('\n')

  const prompt = [
    `BRIEF: ${brief.title}`,
    `OBJECTIVE: ${brief.objective}`,
    brief.audienceNote ? `AUDIENCE: ${brief.audienceNote}` : '',
    brief.keyMessages.length ? `KEY MESSAGES:\n${brief.keyMessages.map((m) => `- ${m}`).join('\n')}` : '',
    brief.callToAction ? `CALL TO ACTION: ${brief.callToAction}` : '',
    brief.mustInclude.length ? `MUST INCLUDE: ${brief.mustInclude.join(', ')}` : '',
    brief.mustAvoid.length ? `MUST AVOID: ${brief.mustAvoid.join(', ')}` : '',
    args.instruction ? `EXTRA INSTRUCTION: ${args.instruction}` : '',
    args.competitiveContext ? `\n${args.competitiveContext}` : '',
    '',
    `Produce ${n} variant(s) for EACH of these channels:`,
    ...channels.map((c) => `- ${c}: ${CHANNEL_GUIDE[c] ?? 'Write appropriately for this channel.'}`),
  ]
    .filter(Boolean)
    .join('\n')

  const result = await run({
    agent: 'content.generate',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: outputSchema,
    tier: 'smart',
    temperature: 0.85,
    maxTokens: 4000,
    subject: { type: 'brief', id: brief.id },
    simulate: () => ({ variants: simulateVariants(brief, profile, channels, n, args.instruction) }),
  })

  return {
    variants: result.data.variants,
    simulated: result.meta.simulated,
    latencyMs: result.meta.latencyMs,
    costUsd: result.meta.costUsd,
  }
}

/* ------------------------------------------------------------ simulator */

/**
 * Angle templates. Each hook stands on its own rather than splicing the brief's
 * objective into a sentence — pasting a verb phrase like "drive 400 signups"
 * into "Every week without ___" produces the kind of broken grammar that makes
 * generated copy obviously generated.
 */
const ANGLES = [
  { key: 'cost-of-delay', title: 'Cost of delay', hook: () => `Every week the work sits between tools costs more than fixing the seam.` },
  { key: 'proof', title: 'Proof first', hook: () => `Teams that made this change stopped rewriting the same brief twice.` },
  { key: 'contrarian', title: 'Contrarian take', hook: () => `More tools did not make marketing faster. Fewer handoffs did.` },
  { key: 'plain-benefit', title: 'Plain benefit', hook: () => `The slow part of a campaign has never been the writing.` },
  { key: 'day-in-life', title: 'Day in the life', hook: () => `Monday brief. Wednesday live. Same team, same budget.` },
  { key: 'question', title: 'Diagnostic', hook: () => `How long does an approval actually take you — measured, not guessed?` },
]

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * The simulator is not a placeholder: it composes real, channel-correct copy
 * from the brief so every screen, score and approval path is demonstrable with
 * no API key. Seeded by brief id, so output is stable across reloads.
 */
export function simulateVariants(
  brief: Pick<
    Brief,
    'id' | 'title' | 'objective' | 'audienceNote' | 'keyMessages' | 'callToAction' | 'mustInclude'
  >,
  profile: BrandProfile,
  channels: string[],
  perChannel: number,
  instruction?: string,
): GeneratedVariant[] {
  const out: GeneratedVariant[] = []
  const messages = brief.keyMessages.length ? brief.keyMessages : [brief.title]
  const cta = brief.callToAction || 'Book a walkthrough'
  const audience = brief.audienceNote || 'marketing teams'
  const playful = profile.tone.playful > 55
  const brief_ = instruction?.toLowerCase().includes('short')

  for (const channel of channels) {
    for (let i = 0; i < perChannel; i++) {
      const label = String.fromCharCode(65 + i)
      const rng = seededRandom(`${brief.id}:${channel}:${label}:${instruction ?? ''}`)
      const angle = ANGLES[(i + channel.length) % ANGLES.length]
      const hook = angle.hook()
      const msg = messages[i % messages.length]
      const second = messages[(i + 1) % messages.length]
      const proof = pick(rng, [
        'Campaign turnaround dropped from weeks to days.',
        'Approvals resolved in under six hours on average.',
        'Ninety-five percent of assets cleared brand review unedited.',
        'Manual handoffs per campaign fell to near zero.',
      ])

      const body = buildBody({
        channel,
        hook,
        msg,
        second,
        proof,
        cta,
        audience,
        title: brief.title,
        playful,
        terse: Boolean(brief_),
        mustInclude: brief.mustInclude,
        rng,
      })

      out.push({
        channel,
        variantLabel: label,
        // Name the asset after what it actually says, not after its angle —
        // that is what a marketer scanning a list needs to recognise it by.
        title: truncate(body.subject ?? body.headline ?? firstSentence(body.body), 62),
        angle: `${angle.title} — leads with ${angle.key.replace(/-/g, ' ')}`,
        body,
        imagePrompt: `Editorial photograph for "${brief.title}". ${cap(audience)} at work, natural light, muted palette with a ${profile.colors.primary} accent, no text overlay, no logos.`,
      })
    }
  }
  return out
}

function buildBody(a: {
  channel: string
  hook: string
  msg: string
  second: string
  proof: string
  cta: string
  audience: string
  title: string
  playful: boolean
  terse: boolean
  mustInclude: string[]
  rng: () => number
}): AssetBody {
  const includes = a.mustInclude.length ? ` ${a.mustInclude.join('. ')}.` : ''
  const tail = a.terse ? '' : ` ${a.proof}`

  switch (a.channel) {
    case 'email':
      return {
        subject: truncate(a.hook.replace(/\.$/, ''), 55),
        preheader: truncate(`${a.msg}${a.playful ? '' : '.'} Two minutes to see how.`, 100),
        body: [
          `Hi there,`,
          `${a.hook} Most ${a.audience} lose the time between the steps, not inside them.`,
          `${cap(a.msg)}.${tail}${includes}`,
          `${cap(a.second)} — and you can see the whole path in one place.`,
        ].join('\n\n'),
        cta: a.cta,
      }
    case 'linkedin':
      return {
        body: [
          a.hook,
          '',
          `${cap(a.msg)}.`,
          `${a.proof}`,
          '',
          `${cap(a.second)}.${includes}`,
          '',
          `${a.cta} →`,
        ].join('\n'),
        hashtags: ['#MarketingOps', '#GenAI', '#Automation'],
      }
    case 'x':
      return {
        body: truncate(`${a.hook} ${cap(a.msg)}. ${a.cta} →`, 262),
        hashtags: ['#MarketingOps'],
      }
    case 'instagram':
      return {
        body: `${a.hook}\n\n${cap(a.msg)}. ${a.terse ? '' : a.proof}\n\n${a.cta} — link in bio.`,
        hashtags: ['#marketing', '#ai', '#automation', '#brand', '#growth'],
        altText: `A small marketing team reviewing a campaign timeline on a large screen.`,
      }
    case 'facebook':
      return { body: `${a.hook}\n\n${cap(a.msg)}. ${tail}\n\n${a.cta}.`, hashtags: [] }
    case 'blog':
      return {
        headline: truncate(a.title, 65),
        body: [
          a.hook,
          `${cap(a.msg)}. The work is not hard because any single step is hard — it is hard because the steps do not talk to each other.`,
          `${a.proof} ${cap(a.second)}.${includes}`,
        ].join('\n\n'),
        cta: a.cta,
      }
    case 'google_ads':
      return {
        headline: truncate(cap(a.msg), 30),
        body: truncate(`${a.hook} ${a.cta}.`, 90),
      }
    case 'meta_ads':
      return {
        headline: truncate(cap(a.msg), 40),
        body: truncate(`${a.hook} ${a.cta}.`, 125),
        altText: 'Campaign timeline on screen.',
      }
    case 'sms':
      return { body: truncate(`${cap(a.msg)}. ${a.cta}:`, 150) }
    case 'push':
      return { headline: truncate(cap(a.msg), 45), body: truncate(`${a.hook} ${a.cta}.`, 140) }
    default:
      return { headline: truncate(a.title, 65), body: `${a.hook}\n\n${cap(a.msg)}.${tail}`, cta: a.cta }
  }
}

function firstSentence(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 12) ?? body
  return line.split(/(?<=[.!?])\s/)[0]?.trim() ?? line
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…'
}
