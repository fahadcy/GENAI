import 'server-only'
import { z } from 'zod'
import { headings, metaContent, titleOf, visibleText } from './html'
import { fetchPublic } from './sources/http'
import { configured } from './sources/config'
import {
  evidenceLine,
  scoreTrade,
  verdictFrom,
  type TradeEvidence,
  type TradeVerdict,
  type TradeVocabulary,
} from './vocab'
import type { Candidate, CompanyProfile } from './types'

/**
 * Does this business actually sell what you sell?
 *
 * Discovery's sources answer "who is near you" and "who ranks for your
 * searches". Neither answers the only question that matters, and the two
 * wrong answers compound: Google Places returns accountants for
 * "insolvency practitioner", and an accountant's page about closing a
 * company ranks for it. So before anything is called a competitor, its own
 * website gets read and checked against the trade vocabulary.
 *
 * The check is deterministic and costs nothing but one page fetch, which is
 * what lets it run on every candidate. The model is called only for the
 * handful the vocabulary cannot settle, and never gets a vote it can use to
 * promote a business the evidence does not support.
 */

export type Verification = {
  verdict: TradeVerdict
  /** 0–100, how strongly the site matches the trade. */
  confidence: number
  evidence: TradeEvidence | null
  /** One line for the person reading the list. */
  note: string
  /** How it was decided, so the UI can say so. */
  decidedBy: 'website' | 'model' | 'name' | 'skipped'
  /** The business type the evidence suggests, when the model was asked. */
  observedType: string | null
}

const UNKNOWN: Verification = {
  verdict: 'unknown',
  confidence: 0,
  evidence: null,
  note: 'No website to check',
  decidedBy: 'skipped',
  observedType: null,
}

function confidenceFrom(e: TradeEvidence, verdict: TradeVerdict): number {
  if (verdict === 'match') return Math.min(100, 55 + Math.round(e.score * 1.6))
  if (verdict === 'weak') return Math.min(54, 20 + Math.round(e.score * 2))
  if (verdict === 'adjacent') return Math.max(0, 15 - Math.round(e.adjacentScore / 2))
  return 0
}

/**
 * Read a homepage and judge it. Falls back to the business name alone when
 * the site cannot be reached, which is weak evidence but better than
 * treating an unreachable site as a match.
 */
export async function verifyCandidate(
  candidate: Pick<Candidate, 'name' | 'domain' | 'types'>,
  vocab: TradeVocabulary,
): Promise<Verification> {
  if (!candidate.domain || !configured('crawler')) {
    // No site to read: judge the name and Google's categories only, and never
    // let that alone promote anything to a confident match.
    const e = scoreTrade(vocab, candidate.types.join(' ').replace(/_/g, ' '), '', candidate.name)
    if (e.score === 0 && e.adjacentScore === 0) return UNKNOWN
    const verdict: TradeVerdict = e.adjacentScore > e.score ? 'adjacent' : e.score >= 8 ? 'weak' : 'unrelated'
    return {
      verdict,
      confidence: Math.min(40, confidenceFrom(e, verdict)),
      evidence: e,
      note: `${evidenceLine(e, verdict)} (name only — no website read)`,
      decidedBy: 'name',
      observedType: null,
    }
  }

  const res =
    (await fetchPublic(`https://${candidate.domain}/`, { timeoutMs: 6000, maxBytes: 300_000 })) ??
    (await fetchPublic(`http://${candidate.domain}/`, { timeoutMs: 5000, maxBytes: 300_000 }))

  if (!res || !res.contentType.includes('html')) {
    // The site is down or blocking us. The name is still evidence: a firm
    // called "ForestKing Insolvency Group" is not an unknown quantity.
    const e = scoreTrade(vocab, '', '', candidate.name)
    const verdict: TradeVerdict =
      e.adjacentScore > e.score ? 'adjacent' : e.score >= 8 ? 'weak' : 'unknown'
    return {
      verdict,
      confidence: verdict === 'weak' ? 35 : 0,
      evidence: e,
      note:
        verdict === 'weak'
          ? `Website would not load, but the name says ${e.strongHits.slice(0, 2).join(', ')}`
          : 'Could not read the website',
      decidedBy: 'name',
      observedType: null,
    }
  }

  const html = res.text
  const headline = [
    titleOf(html),
    metaContent(html, 'description'),
    ...headings(html, 1),
    ...headings(html, 2),
  ].join(' · ')
  const body = visibleText(html).slice(0, 20_000)

  const evidence = scoreTrade(vocab, body, headline, candidate.name)
  const verdict = verdictFrom(evidence)
  return {
    verdict,
    confidence: confidenceFrom(evidence, verdict),
    evidence,
    note: evidenceLine(evidence, verdict),
    decidedBy: 'website',
    observedType: null,
  }
}

/* ----------------------------------------------------------- model break */

const judgeSchema = z.object({
  competes: z.boolean(),
  observedType: z.string().max(80),
  reason: z.string().max(200),
})

/**
 * Ask the model only about the ones the vocabulary called `weak`.
 *
 * It is given the page's own words and asked a single closed question. It can
 * confirm a weak match or reject it; it cannot invent one, because candidates
 * the vocabulary scored at zero never reach here. That keeps the expensive,
 * variable step off the critical path and out of the position where it could
 * do damage.
 */
export async function judgeWeakMatch(args: {
  workspaceId: string
  userId: string | null
  profile: CompanyProfile
  candidate: Pick<Candidate, 'name' | 'domain'>
  verification: Verification
}): Promise<Verification> {
  const { verification: v } = args
  if (v.verdict !== 'weak' || !v.evidence) return v

  const system =
    'You decide whether one business competes with another. Answer only from the evidence given. ' +
    'Two firms compete when a customer would realistically choose between them for the same job. ' +
    'A firm in a neighbouring profession that refers work to the other does not compete with it.'
  const prompt = [
    `Our business: ${args.profile.companyName} — ${args.profile.businessType}.`,
    `We are chosen for: ${args.profile.keywords.join(', ')}.`,
    '',
    `Candidate: ${args.candidate.name}${args.candidate.domain ? ` (${args.candidate.domain})` : ''}.`,
    `Service words found on their site: ${[...v.evidence.strongHits, ...v.evidence.supportingHits].join(', ') || 'none'}.`,
    `Other-trade words found on their site: ${v.evidence.adjacentHits.join(', ') || 'none'}.`,
    '',
    'Does the candidate compete with us for the same customers and the same work?',
  ].join('\n')

  const { run } = await import('@/lib/ai/gateway')
  const result = await run({
    agent: 'competitors.verify',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: judgeSchema,
    tier: 'fast',
    temperature: 0,
    maxTokens: 160,
    cacheTtlSeconds: 14 * 86400,
    // Without a model the vocabulary's own verdict stands, unchanged.
    simulate: () => ({
      competes: v.evidence!.score >= 8 && v.evidence!.score > v.evidence!.adjacentScore,
      observedType: '',
      reason: 'Decided from the website words alone.',
    }),
  })

  const d = result.data
  return {
    verdict: d.competes ? 'match' : 'adjacent',
    confidence: d.competes ? Math.max(55, v.confidence) : Math.min(20, v.confidence),
    evidence: v.evidence,
    note: d.reason || v.note,
    decidedBy: 'model',
    observedType: d.observedType || null,
  }
}

/**
 * Verify a list, a few at a time.
 *
 * Concurrency is deliberately low: these are other people's websites, and the
 * crawler identifies itself and honours robots elsewhere in this module. Six
 * at a time reads thirty candidates in under a minute without looking like an
 * attack to anyone's WAF.
 */
export async function verifyAll<T extends Pick<Candidate, 'key' | 'name' | 'domain' | 'types'>>(
  candidates: readonly T[],
  vocab: TradeVocabulary,
  concurrency = 8,
): Promise<Map<string, Verification>> {
  const out = new Map<string, Verification>()
  const queue = [...candidates]
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const c = queue.shift()
      if (!c) return
      try {
        out.set(c.key, await verifyCandidate(c, vocab))
      } catch {
        out.set(c.key, UNKNOWN)
      }
    }
  })
  await Promise.all(workers)
  return out
}
