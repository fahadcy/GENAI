import type { Intent } from './types'
import { queryKey } from './normalise'

/**
 * Rule-based intent classification.
 *
 * Deliberately not a model: the drift engine compares intent distributions
 * week over week, and a classifier whose answers move when the vendor ships a
 * new checkpoint would manufacture drift that is not in the traffic.
 * Rules are ordered — the first family that matches wins — and every result
 * carries the rule that fired, so a disputed label can be traced.
 */

interface Rule {
  intent: Intent
  name: string
  test: RegExp
}

const RULES: Rule[] = [
  {
    intent: 'careers',
    name: 'careers',
    test: /\b(jobs?|salary|salaries|careers?|courses?|certifications?|certificates?|internships?|degree|training|hiring|resume|cv|interview questions|apprenticeships?|remote roles?)\b/,
  },
  // "free trial" / "free demo" is a buyer, not a free-seeker, so it is excluded here.
  {
    intent: 'free_seeker',
    name: 'free',
    test: /\b(free(?! (trial|demo|consultation|audit))|open source|download|crack(ed)?|torrent|pdf|template free)\b/,
  },
  {
    intent: 'commercial',
    name: 'comparison',
    test: /\b(best(?! practices?)|vs|versus|compare|comparison|alternatives?|reviews?|rated|top \d+|top)\b/,
  },
  {
    intent: 'informational',
    name: 'question',
    test: /^(how|what|why|when|who|which|is|are|can|does|do)\b|\b(guide|examples?|ideas|templates?|tutorial|definition|meaning|tips|statistics|stats|explained|checklist|benefits|strategy|strategies|best practices)\b/,
  },
  {
    intent: 'transactional',
    name: 'buyer',
    test: /\b(software|platforms?|tools?|pricing|prices?|cost|buy|demo|trial|agency|agencies|services?|company|companies|providers?|hire|quote|subscription|plans?|solutions?|vendor)\b/,
  },
]

export interface IntentResult {
  intent: Intent
  rule: string
}

export function classifyIntent(
  query: string,
  brandTerms: string[] = [],
  competitorTerms: string[] = [],
): IntentResult {
  const q = queryKey(query)
  for (const rule of RULES.slice(0, 2)) {
    if (rule.test.test(q)) return { intent: rule.intent, rule: rule.name }
  }
  // Navigational after careers/free: "cy group jobs" is a careers search, not a brand one.
  const has = (t: string) => {
    const k = queryKey(t)
    return !!k && new RegExp(`(^|\\s)${escape(k)}(\\s|$)`).test(q)
  }
  if (brandTerms.some(has)) return { intent: 'navigational', rule: 'brand' }
  // Someone searching a competitor's name next to ours, or for its alternatives, is comparing.
  if (competitorTerms.some(has)) return { intent: 'commercial', rule: 'competitor' }
  for (const rule of RULES.slice(2)) {
    if (rule.test.test(q)) return { intent: rule.intent, rule: rule.name }
  }
  return { intent: 'commercial', rule: 'default' }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Intents a buyer-facing campaign should pay for. The rest is routed elsewhere. */
export const PAYABLE_INTENTS: ReadonlySet<Intent> = new Set(['transactional', 'commercial', 'navigational'])

/** Intents organic content can serve more cheaply than an auction. */
export const ORGANIC_INTENTS: ReadonlySet<Intent> = new Set(['informational', 'commercial'])
