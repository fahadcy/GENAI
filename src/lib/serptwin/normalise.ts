/**
 * Query normalisation. Paid and organic only join if the same search is
 * spelled the same way on both sides; Search Console lowercases and trims,
 * Google Ads preserves close-variant spelling. This is the one place both are
 * folded to a common key.
 */

const PUNCT = /[^\p{L}\p{N}£$€%&+#\s'-]/gu

export function queryKey(q: string): string {
  return q
    .toLowerCase()
    .normalize('NFKC')
    .replace(PUNCT, ' ')
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'for',
  'of',
  'to',
  'in',
  'on',
  'with',
  'by',
  'at',
  'is',
  'are',
  'my',
  'your',
  'our',
  'me',
  'i',
  'you',
  'it',
  'from',
  'or',
  'vs',
  'uk',
  'near',
  'best',
  'top',
])

export function tokens(q: string): string[] {
  return queryKey(q).split(' ').filter(Boolean)
}

export function contentTokens(q: string): string[] {
  return tokens(q).filter((t) => !STOPWORDS.has(t) && t.length > 1)
}

export function microsToMoney(micros: number): number {
  return micros / 1_000_000
}

export function round(n: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

export function formatMoney(n: number, currency: 'GBP' | 'USD' | 'EUR' = 'GBP'): string {
  const sym = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : '€'
  const sign = n < 0 ? '−' : ''
  const abs = Math.abs(n)
  const body = abs >= 1000 ? Math.round(abs).toLocaleString('en-GB') : abs.toFixed(abs < 10 ? 2 : 0)
  return `${sign}${sym}${body}`
}

export function pct(n: number, dp = 0): string {
  return `${(n * 100).toFixed(dp)}%`
}

export function titleCase(s: string): string {
  const small = new Set(['a', 'an', 'and', 'the', 'for', 'of', 'to', 'in', 'on', 'with', 'vs', 'or'])
  return s
    .split(' ')
    .map((w, i) => {
      if (/^(ai|uk|b2b|b2c|crm|seo|ppc|roi|saas|api|us|eu)$/i.test(w)) return w.toUpperCase()
      if (i > 0 && small.has(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')
}

/** Deterministic id from parts, so the same finding keeps the same id across runs. */
export function stableId(...parts: string[]): string {
  let h = 2166136261
  for (const ch of parts.join('␟')) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
