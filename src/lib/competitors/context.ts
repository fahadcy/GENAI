/**
 * Competitive context for the generators.
 *
 * This is where competitor intelligence stops being a report and starts
 * changing what GenAI writes. The content agent, the Google Ads agent and the
 * video brief all receive the same block, cut from the latest landscape:
 * the promises every competitor already makes (so the copy does not sound the
 * same), the angles nobody owns, what competitors' customers complain about,
 * and what this business can credibly claim.
 *
 * The block also carries the rules that keep it lawful. Comparative
 * advertising is permitted in the UK, but only when it is verifiable and does
 * not denigrate (CAP Code 3.33–3.44), so the generators are told not to name
 * competitors at all, and the guardrail flags any copy that does.
 *
 * Pure: no I/O.
 */

import { CLAIM_LABEL } from '@/lib/serptwin/claims'
import { PAIN_THEMES } from './analysis'
import type { LandscapeReport } from './types'

/** Claims that are form, not substance: a call to action or a digit is not a promise. */
export const NOT_A_PROMISE: ReadonlySet<string> = new Set(['cta', 'specificity', 'feature'])

export type CompetitorContextBlock = {
  text: string
  brandNames: string[]
  competitorIds: string[]
}

/**
 * The bits of a business name that would identify it in copy. "Northgate
 * Insolvency Partners Ltd" → ["Northgate Insolvency Partners", "Northgate"].
 * Generic words alone are not brand names, so "Insolvency" never is.
 */
export function brandTerms(name: string, generic: readonly string[] = []): string[] {
  const cleaned = name
    .replace(/\b(ltd|limited|llp|plc|uk|group|holdings)\b\.?/gi, '')
    .replace(/[^\p{L}\p{N}&' -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return []
  const genericSet = new Set(
    [
      ...generic.flatMap((g) => g.toLowerCase().split(/\s+/)),
      'the',
      'and',
      'co',
      'company',
      'services',
      'partners',
      'associates',
      'direct',
      'specialists',
      'advisory',
      'solutions',
      'consulting',
      'local',
      'uk',
      'business',
    ].map((w) => w.toLowerCase()),
  )
  const out = [cleaned]
  const first = cleaned.split(' ')[0]
  if (first && first.length >= 4 && !genericSet.has(first.toLowerCase())) out.push(first)
  return Array.from(new Set(out))
}

export function buildContextBlock(
  report: LandscapeReport,
  opts: { businessType: string; keywords: string[]; selfName: string },
): CompetitorContextBlock {
  const n = Math.max(1, report.competitorIds.length)
  const crowded = report.claims.filter((c) => c.competitorsUsing / n >= 0.5 && !NOT_A_PROMISE.has(c.claim))
  const open = report.claims.filter(
    (c) => c.competitorsUsing / n <= 0.25 && !['cta', 'specificity', 'feature', 'urgency'].includes(c.claim),
  )
  const pains = report.painPoints.slice(0, 4)
  const gaps = report.content.filter((c) => !c.weCover && c.competitors.length >= 2).slice(0, 4)

  const lines = [
    `COMPETITIVE CONTEXT (from ${report.competitorIds.length} tracked competitors, analysed ${report.generatedAt.slice(0, 10)}${report.simulated ? ', partly simulated data' : ''}):`,
    crowded.length
      ? `- Promises competitors already make, so they will not set this copy apart: ${crowded
          .map((c) => `${CLAIM_LABEL[c.claim].toLowerCase()} (${c.competitorsUsing}/${report.competitorIds.length})`)
          .join(', ')}. Use them only as supporting detail.`
      : '',
    open.length
      ? `- Angles few or no competitors use: ${open.map((c) => `${CLAIM_LABEL[c.claim].toLowerCase()}${c.us ? ' (we already say this)' : ''}`).join(', ')}. Prefer these where the brief supports them.`
      : '',
    pains.length
      ? `- What competitors' customers complain about: ${pains
          .map((p) => {
            const t = PAIN_THEMES.find((x) => x.theme === p.theme)
            return `${t?.phrase ?? p.label.toLowerCase()}${t ? ` → ${t.answer}` : ''}`
          })
          .join(' | ')}. Show how we avoid these, without referring to anyone else.`
      : '',
    report.differentiators.length
      ? `- What we can credibly own: ${report.differentiators.map((d) => d.text).join(' ')}`
      : '',
    gaps.length ? `- Questions competitors answer and we have not yet: ${gaps.map((g) => g.topic.toLowerCase()).join(', ')}.` : '',
    'RULES FOR USING THIS CONTEXT:',
    '- Never name a competitor or use their brand names, slogans or headlines.',
    '- No comparative or superlative claims ("cheaper than", "faster than others", "the best", "No.1", "leading") unless the brief supplies the evidence.',
    '- Do not copy competitor phrasing. Differentiate on substance, not by imitation.',
  ].filter(Boolean)

  const brandNames = Array.from(
    new Set(Object.values(report.names).flatMap((name) => brandTerms(name, [opts.businessType, ...opts.keywords]))),
  ).filter((b) => b.toLowerCase() !== opts.selfName.toLowerCase())

  return { text: lines.join('\n'), brandNames, competitorIds: report.competitorIds }
}

/** A Google Ads negative keyword per competitor brand: navigational searches for a named rival rarely switch. */
export function competitorNegatives(brandNames: string[]): { text: string; matchType: 'PHRASE'; reason: string }[] {
  const seen = new Set<string>()
  const out: { text: string; matchType: 'PHRASE'; reason: string }[] = []
  for (const b of brandNames) {
    const text = b
      .toLowerCase()
      .replace(/[^a-z0-9 &']/g, ' ')
      .replace(/&/g, 'and')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 10)
      .join(' ')
    // Full names only. A one-word brand ("Northgate") is often a place or an
    // ordinary word too, and blocking it would cost real customers.
    if (text.split(' ').length < 2 || text.length < 6 || seen.has(text)) continue
    seen.add(text)
    out.push({
      text,
      matchType: 'PHRASE',
      reason: 'Competitor brand. People searching for a named competitor rarely switch; remove this only if you decide to run a conquest campaign.',
    })
  }
  return out.slice(0, 20)
}
