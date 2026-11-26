import 'server-only'
import type { SerpResult } from './sources/serp'

/**
 * A search result page is the same for every competitor scanned against it,
 * so a scan of ten competitors on six keywords is six paid searches, not
 * sixty. In-process and short-lived: results go stale within hours and a
 * restart costs at most one extra search per keyword.
 */
const cache = new Map<string, { at: number; value: SerpResult | null }>()
/** Searches in flight, so two scans asking at once pay for one search. */
const pending = new Map<string, Promise<SerpResult | null>>()
const TTL_MS = 6 * 3600_000

export async function cachedSerp(query: string, fetcher: () => Promise<SerpResult | null>): Promise<SerpResult | null> {
  const key = query.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const inflight = pending.get(key)
  if (inflight) return inflight
  const p = fetcher()
  pending.set(key, p)
  let value: SerpResult | null
  try {
    value = await p
  } finally {
    pending.delete(key)
  }
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
    for (const [k] of oldest) cache.delete(k)
  }
  return value
}

export function clearSerpCache() {
  cache.clear()
}
