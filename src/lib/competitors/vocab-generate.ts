import 'server-only'
import { z } from 'zod'
import { buildVocabulary, clean, genericVocabulary, vocabularyFor, type TradeVocabulary } from './vocab'
import type { CompanyProfile } from './types'

/**
 * A trade vocabulary for any business, written once and then frozen.
 *
 * Hand-curating a word list per trade does not scale past the first one, and
 * the deterministic fallback — split the profile's own keywords into words —
 * cannot know the thing that matters most: which neighbouring trade keeps
 * being mistaken for yours. For insolvency that is accountancy, and nothing
 * in the phrase "insolvency practitioner" says so.
 *
 * So the model writes the vocabulary, once per business type, and the result
 * is cached and then used as pure data. That keeps the division this module
 * is built on: the model does the part that tolerates variance — naming the
 * words of a trade — and the scoring that decides who is a competitor stays a
 * pure function with the same answer every run.
 *
 * Everything it returns is checked before use. A model that returns "company"
 * as a strong term would quietly match the whole internet, so generic words
 * are stripped, short terms are dropped, and a vocabulary that comes back too
 * thin is discarded in favour of the deterministic one.
 */

const termList = z.array(z.string().min(3).max(60)).max(40)

const vocabSchema = z.object({
  /** Terms that, on a homepage, settle that this firm is in the trade. */
  strong: termList,
  /** Terms consistent with the trade but not proof alone. */
  supporting: termList,
  /** The neighbouring trade that is easy to confuse with this one. */
  adjacentTradeName: z.string().max(80),
  adjacent: termList,
  /** Words in a business name that nearly always mean the adjacent trade. */
  adjacentNameHints: z.array(z.string().min(3).max(40)).max(20),
  /** What a customer actually types into Google. */
  searchTerms: z.array(z.string().min(4).max(80)).max(10),
})

const SYSTEM = [
  'You write the vocabulary of a trade: the words a firm in it cannot avoid putting on its website.',
  'You are not describing one company. You are describing what any firm in that trade sells.',
  'Use the words customers and firms actually use in the United Kingdom, including terms of art and common acronyms.',
  'Never use generic business words such as service, solution, company, expert, professional or quality.',
  'The adjacent trade is the neighbouring profession most often mistaken for this one in a web search —',
  'the one whose firms would show up in the same results but which a customer would never choose instead.',
  'For an insolvency practitioner that is accountancy. For a plumber it is electrical work.',
].join(' ')

function promptFor(businessType: string, keywords: readonly string[]): string {
  return [
    `Trade: ${businessType}`,
    keywords.length ? `Searches this business is chosen for: ${keywords.join(', ')}` : '',
    '',
    'Give:',
    'strong — 10 to 20 terms that prove a website belongs to this trade. Prefer multi-word phrases.',
    'supporting — 10 to 20 terms consistent with the trade, including acronyms.',
    'adjacentTradeName — the neighbouring profession most often confused with it.',
    'adjacent — 10 to 20 terms that belong to that neighbouring trade and not to this one.',
    'adjacentNameHints — words appearing in the names of firms in that neighbouring trade.',
    'searchTerms — up to 8 phrases a customer would type into Google to find this trade.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The vocabulary for a profile.
 *
 * Curated lists win when one matches: they are hand-tuned and cost nothing.
 * Otherwise the model writes one and it is cached for ninety days, so a
 * workspace pays for this once rather than once per discovery run. With no
 * model configured the deterministic vocabulary is used, which still checks
 * that a candidate sells what you sell — it just cannot name the trade next
 * door.
 */
export async function resolveVocabulary(args: {
  workspaceId: string
  userId?: string | null
  profile: CompanyProfile
}): Promise<{ vocab: TradeVocabulary; source: 'curated' | 'generated' | 'profile' }> {
  const { profile } = args
  const curated = vocabularyFor(profile.businessType, profile.keywords)
  if (curated) return { vocab: curated, source: 'curated' }

  const fallback = genericVocabulary(profile.businessType, profile.keywords)
  const type = clean(profile.businessType)
  // No business type, or no workspace to meter and cache the call against:
  // use the deterministic vocabulary rather than an unattributed model call.
  if (!type || !args.workspaceId) return { vocab: fallback, source: 'profile' }

  try {
    const { run } = await import('@/lib/ai/gateway')
  const result = await run({
      agent: 'competitors.vocabulary',
      workspaceId: args.workspaceId,
      userId: args.userId ?? null,
      system: SYSTEM,
      prompt: promptFor(profile.businessType, profile.keywords),
      schema: vocabSchema,
      tier: 'smart',
      temperature: 0,
      maxTokens: 1200,
      cacheTtlSeconds: 90 * 86400,
      simulate: () => ({
        strong: fallback.strong.map((t) => t.term),
        supporting: fallback.supporting.map((t) => t.term),
        adjacentTradeName: '',
        adjacent: [],
        adjacentNameHints: [],
        searchTerms: fallback.searchTerms,
      }),
    })
    // The gateway falls back to `simulate` when the provider fails, which
    // returns the deterministic vocabulary. Saying "generated" then would be
    // a lie on screen about where the judgement came from.
    if (result.meta.simulated) return { vocab: fallback, source: 'profile' }
    const built = buildVocabulary(
      `generated:${type}`,
      result.data.adjacentTradeName ? `${profile.businessType} (next door: ${result.data.adjacentTradeName})` : profile.businessType,
      result.data,
    )
    return built ? { vocab: built, source: 'generated' } : { vocab: fallback, source: 'profile' }
  } catch {
    return { vocab: fallback, source: 'profile' }
  }
}
