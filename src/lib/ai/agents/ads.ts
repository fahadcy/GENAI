import 'server-only'
import { z } from 'zod'
import { pick, run, seededRandom } from '../gateway'
import { RSA, KEYWORD, autoRepair, trimToLength } from '@/lib/ads/validate'
import { objectiveDef } from '@/lib/ads/objectives'
import type { AdCampaignStructure, AdObjective, BrandProfile } from '@/lib/db/schema'
import { competitorNegatives } from '@/lib/competitors/context'

/**
 * The campaign agent.
 *
 * The person using this has told us, in a sentence, what their business does
 * and what they want. Everything a Google Ads account would normally demand of
 * them — ad group structure, match types, negative keywords, fifteen headlines
 * under thirty characters each, sitelinks — is produced here and then explained
 * back to them in the review screen.
 *
 * Three things are deliberately *not* left to the model:
 *
 *  - Money. Budget, bidding strategy and channel come from the objective table
 *    in `lib/ads/objectives`, in code, the same every time.
 *  - Limits. Whatever comes back is run through `autoRepair` before anyone sees
 *    it, so a 34-character headline is trimmed rather than shown as an error to
 *    someone who did not write it.
 *  - Brand safety. The copy still goes through the existing guardrail scoring
 *    and the approval chain, exactly like organic content.
 */

const keywordSchema = z.object({
  text: z.string().min(1),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']),
  rationale: z.string().optional(),
})

const creativeSchema = z.object({
  headlines: z.array(z.string()).min(3).max(15),
  descriptions: z.array(z.string()).min(2).max(4),
  path1: z.string().optional(),
  path2: z.string().optional(),
})

const adGroupSchema = z.object({
  name: z.string().min(1),
  theme: z.string().min(1),
  keywords: z.array(keywordSchema).min(1),
  ads: z.array(creativeSchema).min(1),
})

const structureSchema = z.object({
  adGroups: z.array(adGroupSchema).min(1).max(6),
  negativeKeywords: z
    .array(z.object({ text: z.string().min(1), matchType: z.string(), reason: z.string() }))
    .default([]),
  sitelinks: z
    .array(
      z.object({
        text: z.string().min(1),
        description1: z.string().optional(),
        description2: z.string().optional(),
        finalUrl: z.string(),
      }),
    )
    .default([]),
  callouts: z.array(z.string()).default([]),
  rationale: z.string().default(''),
})

export type GenerateAdCampaignArgs = {
  workspaceId: string
  userId?: string | null
  /** Stable id used to seed the simulator so reloads do not reshuffle the plan. */
  seedId: string
  /** What the user typed. Plain language, no marketing vocabulary expected. */
  brief: string
  objective: AdObjective
  businessName: string
  finalUrl: string
  currencyCode: string
  dailyBudget: number
  locations: string[]
  profile?: BrandProfile | null
  /** e.g. "focus on the enterprise plan" on a regenerate. */
  instruction?: string
  /**
   * From Competitors: what the competition already says and where it leaves
   * room. Competitor brand names also become negative keywords, in code.
   */
  competitiveContext?: { text: string; brandNames: string[] } | null
}

export async function generateAdCampaign(args: GenerateAdCampaignArgs): Promise<{
  structure: AdCampaignStructure
  simulated: boolean
  repaired: number
  latencyMs: number
  costUsd: number
}> {
  const objective = objectiveDef(args.objective)
  const domain = safeDomain(args.finalUrl)

  const system = [
    'You are a Google Ads specialist building a search campaign for a business owner who does not work in marketing.',
    'They will read your work and have to trust it, so every choice must be defensible in plain English.',
    '',
    'Hard rules, because Google rejects anything that breaks them:',
    `- Headlines: max ${RSA.headlineChars} characters. Never use an exclamation mark in a headline.`,
    `- Descriptions: max ${RSA.descriptionChars} characters.`,
    `- Keywords: max ${KEYWORD.maxWords} words, no ! @ % , or * characters.`,
    '- No words in ALL CAPS for emphasis. No repeated punctuation. No decorative symbols.',
    '- Never invent a statistic, a price, a guarantee, an award or a review count.',
    '',
    'Structure rules:',
    '- Build 2 to 4 ad groups, each around ONE tight theme. An ad group whose keywords span several ideas gets a poor quality score and costs more per click.',
    `- Give each ad group 8 to ${KEYWORD.softMaxPerAdGroup} keywords. Mix match types: exact for the terms that clearly signal buying intent, phrase for the rest, broad only where the wording genuinely varies.`,
    '- Give each ad group ONE responsive search ad with 12-15 distinct headlines and 4 descriptions.',
    '- Roughly a third of the headlines should contain the ad group\'s main keyword. The others should carry benefits, credibility and the call to action. Do not simply reword one idea fifteen times.',
    '- Supply 12-20 negative keywords with a short reason for each. Cover: people looking for a free version, people looking for jobs, people researching rather than buying, and anything the business explicitly does not sell.',
    '- Supply 4-6 sitelinks and 4-6 callouts.',
    '',
    args.profile ? brandBlock(args.profile) : '',
    '',
    'Return JSON matching: { adGroups: [{ name, theme, keywords: [{text, matchType, rationale}], ads: [{headlines, descriptions, path1, path2}] }], negativeKeywords: [{text, matchType, reason}], sitelinks: [{text, description1, description2, finalUrl}], callouts: [string], rationale }',
    'rationale is 2-4 sentences addressed to the business owner explaining how you split the ad groups and why. No jargon without a plain-English gloss.',
  ]
    .filter(Boolean)
    .join('\n')

  const prompt = [
    `BUSINESS: ${args.businessName}`,
    `WHAT THEY WANT: ${args.brief}`,
    `GOAL: ${objective.label} — ${objective.summary}`,
    `LANDING PAGE: ${args.finalUrl}`,
    `DISPLAY DOMAIN: ${domain} (display paths must fit ${RSA.pathChars} characters each)`,
    `DAILY BUDGET: ${args.currencyCode} ${args.dailyBudget}`,
    args.locations.length ? `TARGETING: ${args.locations.join(', ')}` : '',
    args.instruction ? `EXTRA INSTRUCTION: ${args.instruction}` : '',
    args.competitiveContext
      ? `\n${args.competitiveContext.text}\nFor ads specifically: never put a competitor's name or trademark in a headline, description or path. Make headlines carry the angles competitors do not use.`
      : '',
    '',
    `The budget is modest, so concentrate the keywords on searches with clear ${
      args.objective === 'sales' ? 'buying' : 'enquiry'
    } intent rather than casting wide.`,
  ]
    .filter(Boolean)
    .join('\n')

  const result = await run({
    agent: 'ads.campaign',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: structureSchema,
    tier: 'smart',
    temperature: 0.7,
    maxTokens: 6000,
    subject: { type: 'ad_campaign', id: args.seedId },
    simulate: () => simulateStructure(args),
  })

  // Whatever came back — model or simulator — gets held to Google's limits
  // before a human ever sees it.
  const { structure, repaired } = autoRepair(normalise(result.data as AdCampaignStructure, args))

  return {
    structure,
    repaired,
    simulated: result.meta.simulated,
    latencyMs: result.meta.latencyMs,
    costUsd: result.meta.costUsd,
  }
}

/* ------------------------------------------------------------------ shaping */

function normalise(structure: AdCampaignStructure, args: GenerateAdCampaignArgs): AdCampaignStructure {
  const negatives = (structure.negativeKeywords ?? []).map((n) => ({
    ...n,
    matchType: ['EXACT', 'PHRASE', 'BROAD'].includes(n.matchType?.toUpperCase())
      ? n.matchType.toUpperCase()
      : 'PHRASE',
  }))
  // Competitor brands as negatives, added in code rather than asked of the
  // model: someone searching for a named rival is looking for that firm, and
  // paying for the click rarely wins them.
  const have = new Set(negatives.map((n) => n.text.toLowerCase()))
  for (const n of competitorNegatives(args.competitiveContext?.brandNames ?? [])) {
    if (!have.has(n.text)) negatives.push(n)
  }
  return {
    ...structure,
    negativeKeywords: negatives,
    sitelinks: (structure.sitelinks ?? []).map((l) => ({
      ...l,
      // A model will happily invent /pricing on a site that has no such page.
      // Pointing every sitelink at the page we know exists is the safe default;
      // the review screen lets the user correct any of them.
      finalUrl: isSameSite(l.finalUrl, args.finalUrl) ? l.finalUrl : args.finalUrl,
    })),
    callouts: structure.callouts ?? [],
    rationale: structure.rationale ?? '',
  }
}

function isSameSite(candidate: string, base: string): boolean {
  try {
    return new URL(candidate).hostname === new URL(base).hostname
  } catch {
    return false
  }
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function brandBlock(p: BrandProfile): string {
  return [
    `BRAND VOICE: ${p.voice || 'Clear, credible, human.'}`,
    p.bannedTerms.length ? `BANNED WORDS (must not appear anywhere): ${p.bannedTerms.join(', ')}` : '',
    p.preferredTerms.length
      ? `PREFERRED WORDING: ${p.preferredTerms.map((t) => `say "${t.use}" not "${t.avoid}"`).join('; ')}`
      : '',
    p.dontList.length ? `NEVER: ${p.dontList.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* ---------------------------------------------------------------- simulator */

/**
 * The simulator builds a real campaign, not a placeholder.
 *
 * It has to, for two reasons. Someone evaluating this platform without an
 * OpenAI key should see the product actually work. And more importantly, a
 * Google developer token takes days of manual review to approve — so in the
 * window before it lands, the simulated plan is what people build, review and
 * approve. Producing something that looks plausible but is structurally wrong
 * would be worse than producing nothing.
 *
 * The approach is intent-based: pull the subject of the brief out, then build
 * one ad group per commercial intent tier — people ready to buy, people
 * comparing, people looking for a local supplier — because that is how a
 * competent human would split it, and because match types and negatives follow
 * naturally from the split.
 */
export function simulateStructure(args: GenerateAdCampaignArgs): AdCampaignStructure {
  const rng = seededRandom(`${args.seedId}:${args.instruction ?? ''}`)
  const subject = extractSubject(args.brief, args.businessName)
  const place = args.locations[0]?.split(',')[0]?.trim()
  const objective = objectiveDef(args.objective)
  const buying = args.objective === 'sales'

  const tiers: { name: string; theme: string; modifiers: string[]; primary: boolean }[] = [
    {
      name: `${cap(subject)} — ready to buy`,
      theme: `People searching for ${subject} with clear intent to ${buying ? 'buy now' : 'get in touch'}.`,
      modifiers: buying
        ? ['buy', 'order', 'price', 'cost', 'online']
        : ['quote', 'get a quote', 'enquiry', 'contact', 'consultation'],
      primary: true,
    },
    {
      name: `${cap(subject)} — comparing options`,
      theme: `People still choosing between suppliers. Slightly cheaper clicks, slower to convert.`,
      modifiers: ['best', 'top', 'compare', 'reviews of', 'which'],
      primary: false,
    },
    ...(place
      ? [
          {
            name: `${cap(subject)} — ${place}`,
            theme: `Searches that name ${place}. These convert well because the person has already decided they want someone nearby.`,
            modifiers: [`in ${place}`, `${place}`, `near me`, `${place} based`],
            primary: false,
          },
        ]
      : []),
  ]

  const adGroups = tiers.map((tier) => {
    const keywords = buildKeywords(subject, tier.modifiers, tier.primary)
    return {
      name: trimToLength(tier.name, 60),
      theme: tier.theme,
      keywords,
      ads: [buildCreative(subject, args, tier.primary, rng)],
    }
  })

  return {
    adGroups,
    negativeKeywords: buildNegatives(subject, buying),
    sitelinks: buildSitelinks(args, subject),
    callouts: buildCallouts(args, place),
    rationale: [
      `I split this into ${adGroups.length} ad groups by how ready the searcher is, because Google charges less per click when the ad closely matches the search.`,
      `"${adGroups[0].name}" gets the tightest keywords and the most direct copy — that is where most of the budget should land.`,
      `${objective.biddingReason}`,
      `I have also added ${buildNegatives(subject, buying).length} negative keywords, which stop the ads showing for searches like "free" or "jobs" that spend money without ever buying anything.`,
    ].join(' '),
  }
}

/** Pull the thing being sold out of a sentence written by someone in a hurry. */
export function extractSubject(brief: string, businessName: string): string {
  const text = brief.trim().replace(/\s+/g, ' ')
  const patterns = [
    /\b(?:sell|selling|sale of|offer|offering|provide|providing|supply|supplying)\s+(?:our|my|the|a|an)?\s*([a-z][a-z\s-]{2,40}?)(?:\s+(?:to|for|in|across|around|near|at|with|and)\b|[.,]|$)/i,
    /\b(?:bookings?|enquir(?:y|ies)|leads?|orders?|demos?)\s+for\s+(?:our|my|the|a|an)?\s*([a-z][a-z\s-]{2,40}?)(?:\s+(?:to|for|in|across)\b|[.,]|$)/i,
    /\bwe (?:are|do|make|run|build)\s+(?:a|an|the)?\s*([a-z][a-z\s-]{2,40}?)(?:\s+(?:company|business|firm|agency)\b|[.,]|$)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const found = match?.[1]?.trim()
    if (found && found.split(/\s+/).length <= 4) return stripArticles(found)
  }

  // Nothing matched: fall back to the longest noun-ish run in the brief, which
  // is usually the product, and only then to the business name.
  const stop = new Set([
    'want','need','would','like','more','from','that','this','with','have','make','get','our','the','and','for','into','when','they','their','about','looking','people','customers','business','help',
  ])
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w))
  const phrase = words.slice(0, 2).join(' ')
  return phrase || businessName.toLowerCase()
}

const stripArticles = (s: string) => s.replace(/^(?:our|my|the|a|an)\s+/i, '').trim()
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

function buildKeywords(
  subject: string,
  modifiers: string[],
  primary: boolean,
): { text: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; rationale: string }[] {
  const out: { text: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; rationale: string }[] = []
  const seen = new Set<string>()

  const add = (text: string, matchType: 'EXACT' | 'PHRASE' | 'BROAD', rationale: string) => {
    const clean = text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!clean || seen.has(clean) || clean.split(' ').length > KEYWORD.maxWords) return
    seen.add(clean)
    out.push({ text: clean, matchType, rationale })
  }

  if (primary) {
    add(subject, 'EXACT', 'The core term. Exact match so you only pay for this precise search.')
    add(subject, 'PHRASE', 'Catches the same term with words around it.')
  } else {
    add(subject, 'PHRASE', 'The core term with room for variation.')
  }

  for (const modifier of modifiers) {
    const leading = /^(in|near|best|top|compare|which|reviews of)\b/i.test(modifier)
    const phrase = leading ? `${subject} ${modifier}` : `${modifier} ${subject}`
    add(
      phrase,
      primary ? 'EXACT' : 'PHRASE',
      primary
        ? `"${modifier}" is a strong signal the person is ready to act, so this is worth bidding on precisely.`
        : `Catches people using "${modifier}" while they are still deciding.`,
    )
    add(`${phrase} online`, 'PHRASE', 'Same intent, common phrasing.')
  }

  // One broad term per group, so Google can surface wordings nobody predicted —
  // safe only because the negative keyword list is doing its job.
  add(
    subject,
    'BROAD',
    'One broad keyword lets Google find searches nobody thought of. The negative keyword list keeps it from wandering.',
  )

  return out.slice(0, KEYWORD.softMaxPerAdGroup)
}

function buildCreative(
  subject: string,
  args: GenerateAdCampaignArgs,
  primary: boolean,
  rng: () => number,
) {
  const brand = args.businessName
  const place = args.locations[0]?.split(',')[0]?.trim()
  const cta = args.objective === 'sales' ? 'Order online' : 'Get a free quote'

  const candidates = [
    cap(subject),
    `${cap(subject)} from ${brand}`,
    place ? `${cap(subject)} in ${place}` : `${cap(subject)} online`,
    args.objective === 'sales' ? `Buy ${subject} today` : `Ask about ${subject}`,
    cta,
    `${brand} — ${subject}`,
    'Straight answers, no hard sell',
    'Talk to someone who knows',
    place ? `Covering ${place} and nearby` : 'Nationwide service',
    'Clear pricing, no surprises',
    'Fast, careful and reliable',
    args.objective === 'sales' ? 'Delivered when promised' : 'Reply within one working day',
    pick(rng, ['Trusted by local businesses', 'Built for busy teams', 'Done properly, first time']),
    `See what ${subject} costs`,
    'Start with a conversation',
  ]

  const headlines: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const text = trimToLength(candidate.replace(/\s+/g, ' ').trim(), RSA.headlineChars)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    headlines.push(text)
    if (headlines.length >= RSA.headlineMax) break
  }

  const descriptions = [
    `${cap(subject)} from ${brand}${place ? `, serving ${place}` : ''}. ${
      args.objective === 'sales' ? 'Order online in a few minutes.' : 'Tell us what you need and we will come back with a price.'
    }`,
    primary
      ? `Know what you want? Get started now and we will handle the rest.`
      : `Still comparing? We will tell you honestly whether we are the right fit.`,
    `No call centre, no pressure. Speak to someone who can actually answer the question.`,
    `${cta} today and see the difference a straight answer makes.`,
  ].map((d) => trimToLength(d, RSA.descriptionChars))

  const path1 = trimToLength(subject.replace(/[^a-zA-Z0-9\- ]/g, '').split(' ')[0] ?? '', RSA.pathChars)

  return {
    headlines,
    descriptions: descriptions.slice(0, RSA.descriptionMax),
    ...(path1 ? { path1 } : {}),
    ...(args.objective === 'sales' && path1 ? { path2: 'Order' } : {}),
  }
}

/**
 * The negative list is where a campaign stops wasting money. Every entry here
 * corresponds to a search that looks relevant, gets clicked, and never buys.
 */
function buildNegatives(subject: string, buying: boolean): { text: string; matchType: string; reason: string }[] {
  const base = [
    { text: 'free', reason: 'People looking for a free version will click and never buy.' },
    { text: 'cheap', reason: 'Attracts price-only shoppers who rarely convert and drag the average down.' },
    { text: 'jobs', reason: 'Job seekers searching your industry. Costly and irrelevant.' },
    { text: 'careers', reason: 'Same as jobs.' },
    { text: 'salary', reason: 'People researching pay, not buying.' },
    { text: 'diy', reason: 'People intending to do it themselves.' },
    { text: 'how to', reason: 'Research intent. They want an article, not a supplier.' },
    { text: 'what is', reason: 'Definition searches. No commercial intent.' },
    { text: 'meaning', reason: 'Dictionary traffic.' },
    { text: 'course', reason: 'People wanting to learn the skill, not hire it.' },
    { text: 'training', reason: 'Same as course.' },
    { text: 'template', reason: 'People looking for something to download.' },
    { text: 'wikipedia', reason: 'Encyclopaedia traffic.' },
    { text: 'reddit', reason: 'Forum browsers, not buyers.' },
    { text: 'youtube', reason: 'They want a video, not a supplier.' },
    { text: 'second hand', reason: 'Used-goods searches.' },
    { text: 'used', reason: 'Used-goods searches.' },
    { text: 'refund', reason: 'Existing customers with a problem — support, not sales.' },
    { text: 'complaint', reason: 'Support traffic.' },
    { text: 'login', reason: 'Existing customers trying to sign in.' },
  ]
  if (buying) {
    base.push({ text: 'wholesale', reason: 'Trade buyers looking for bulk pricing you may not offer.' })
    base.push({ text: 'near me jobs', reason: 'A very common accidental match.' })
  }
  // Anything containing the subject is already covered by the keyword themes.
  return base
    .filter((n) => !subject.includes(n.text))
    .map((n) => ({ ...n, matchType: n.text.split(' ').length > 1 ? 'PHRASE' : 'BROAD' }))
}

function buildSitelinks(args: GenerateAdCampaignArgs, subject: string) {
  const url = args.finalUrl
  return [
    { text: trimToLength(`About ${args.businessName}`, 25), description1: 'Who we are and how we work.', finalUrl: url },
    { text: args.objective === 'sales' ? 'Pricing' : 'Get a quote', description1: 'What it costs, in plain numbers.', finalUrl: url },
    { text: trimToLength(cap(subject), 25), description1: 'The detail on what you get.', finalUrl: url },
    { text: 'Contact us', description1: 'Speak to a person today.', finalUrl: url },
  ]
}

function buildCallouts(args: GenerateAdCampaignArgs, place?: string) {
  return [
    args.objective === 'sales' ? 'Secure checkout' : 'Free, no-obligation quote',
    place ? trimToLength(`${place} and nearby`, 25) : 'Nationwide coverage',
    'No call centres',
    'Clear pricing',
    'Answer within one day',
  ]
}
