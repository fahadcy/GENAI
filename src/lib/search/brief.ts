import type { Recommendation } from '@/lib/serptwin'

/**
 * Prefill for the Content Studio brief composer, for recommendations that end
 * in a content brief. The brief itself is written, scored and approved in the
 * studio like any other.
 */
export function briefPrefill(
  rec: Recommendation,
): { title: string; objective: string; messages: string[] } | null {
  const brief = rec.actions.find((a) => a.kind === 'create_content_brief')
  if (!brief) return null
  const p = brief.payload as { targetQuery?: string; supporting?: string[]; reason?: string }
  const query = p.targetQuery ?? rec.title
  if (p.reason === 'demand') {
    return {
      title: query,
      objective: `Answer the question customers keep asking before they buy. Outline: ${(p.supporting ?? []).join(' · ')}`,
      messages: (p.supporting ?? []).slice(0, 5),
    }
  }
  const objective =
    p.reason === 'gap'
      ? `Rank organically for "${query}". The site does not appear for it today, while paid search is paying for every click.`
      : p.reason === 'drift'
        ? `Answer "${query}" with a guide, so this demand is served organically instead of bought in the auction.`
        : `Lift the ranking page for "${query}" into the top three organic results.`
  return {
    title: `SEO: ${query}`,
    objective,
    messages: [query, ...(p.supporting ?? [])].slice(0, 5),
  }
}

/** The Content Studio link that opens the brief composer prefilled. */
export function briefHref(rec: Recommendation): string | null {
  const p = briefPrefill(rec)
  if (!p) return null
  const q = new URLSearchParams({
    title: p.title,
    objective: p.objective,
    messages: p.messages.join('|'),
    channels: 'blog,web',
  })
  return `/studio/new?${q.toString()}`
}
