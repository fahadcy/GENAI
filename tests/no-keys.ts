/**
 * Pin a keyless environment, for tests that say they are keyless.
 *
 * `helpers.ts` imports `load-env`, which reads `.env.local` — so on a machine
 * with real credentials configured, a test documented as "with no keys:
 * discovery falls back to the simulated market" quietly made live calls to
 * Google Places and DataForSEO instead, found real businesses, and failed on
 * `assert.equal(r.simulated, true)`. The suite was green on a laptop with an
 * empty `.env.local` and red on anyone's real one, which is the worst way for
 * a test to behave.
 *
 * `env-file` only fills a variable in when it is `undefined`, so setting these
 * first wins, and `env()` caches the keyless result on its first read. Import
 * this BEFORE `./helpers` — module initialisation order is what makes it work.
 *
 * DATABASE_URL and AUTH_SECRET are deliberately left alone: these tests do run
 * against a real database.
 */
const KEYLESS = [
  'GOOGLE_PLACES_API_KEY',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'SERPAPI_API_KEY',
  'SERPER_API_KEY',
  'COMPANIES_HOUSE_API_KEY',
  'YOUTUBE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]

for (const key of KEYLESS) process.env[key] = ''

// No live model, so the gateway uses each agent's deterministic simulator.
process.env.AI_PROVIDER = 'mock'
// The crawler stays on: these tests rely on the address check refusing the
// simulated `.example` hosts, which is a different code path from "off".
process.env.COMPETITOR_CRAWL = 'on'

export {}
