import { z } from 'zod'

/**
 * One place that knows what configuration exists. Anything missing fails loudly
 * at boot rather than at 3am inside a publish worker.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AUTH_SECRET: z.string().min(24, 'AUTH_SECRET must be at least 24 characters'),

  /* AI gateway ------------------------------------------------------------ */
  AI_PROVIDER: z.enum(['openai', 'anthropic', 'mock']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  AI_MODEL_FAST: z.string().default('gpt-4o-mini'),
  AI_MODEL_SMART: z.string().default('gpt-4o'),
  AI_MODEL_IMAGE: z.string().default('gpt-image-1'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model for the growth agent, which needs tool calling. Defaults to AI_MODEL_SMART (or a Claude model when AI_PROVIDER=anthropic). */
  AGENT_MODEL: z.string().optional(),

  /* Google Ads ------------------------------------------------------------ */
  /**
   * All four are needed to reach the live API. With any of them missing the
   * platform runs the faithful simulator instead: campaigns are built,
   * validated and reviewed exactly as they would be, and the push is recorded
   * as simulated rather than sent. That matters because a Google developer
   * token needs a manager account and human review before it works.
   */
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  /** Manager (MCC) account that owns the token, digits only. Sent as login-customer-id. */
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),

  /* Social publishing ----------------------------------------------------- */
  /**
   * Each platform is independent: connecting LinkedIn does not require Meta
   * credentials and vice versa. A channel with no credentials keeps using the
   * simulator, and says so, rather than failing at publish time.
   */
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  /* Email and SMS delivery ------------------------------------------------ */
  /**
   * SendGrid refuses to send from an address it has not verified, so the from
   * address is configuration rather than something a user types per campaign —
   * getting it wrong fails every send with the same unhelpful 403.
   */
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  SENDGRID_FROM_NAME: z.string().optional(),

  /** ClickSend authenticates with the account username plus an API key. */
  CLICKSEND_USERNAME: z.string().optional(),
  CLICKSEND_API_KEY: z.string().optional(),
  /**
   * Sender ID. UK alphanumeric sender IDs cannot receive replies, which means
   * the opt-out has to be a STOP instruction in the body rather than a link.
   */
  CLICKSEND_SENDER_ID: z.string().optional(),

  /* Website / blog --------------------------------------------------------- */
  /**
   * A WordPress site, its REST API reached with an Application Password. No
   * plugin is needed — the API and Application Passwords are both built in.
   */
  WORDPRESS_URL: z.string().optional(),
  WORDPRESS_USERNAME: z.string().optional(),
  WORDPRESS_APP_PASSWORD: z.string().optional(),
  /**
   * Whether an approved post lands as a draft or goes straight live. The
   * default is deliberately the cautious one: the platform's approval was
   * given to a preview, and how a theme renders it is a separate question.
   */
  WORDPRESS_POST_STATUS: z.enum(['draft', 'publish']).default('draft'),

  /* Video generation ------------------------------------------------------- */
  /**
   * Which provider serves live generation. With `simulator` — the default —
   * the whole governed loop runs with no vendor account and no spend: briefs
   * are scored, budgets enforced, clips generated, measured, reviewed and
   * approved, and every record is stored simulated and labelled as such.
   *
   * The fallback exists because this market moves faster than a procurement
   * cycle. The model this feature was first specified against, OpenAI's
   * sora-2, was announced for shutdown three weeks out with no replacement
   * named. Set VIDEO_FALLBACK_PROVIDER and a shutdown notice is a config
   * change rather than a project.
   */
  VIDEO_PROVIDER: z.enum(['google', 'runway', 'simulator']).default('simulator'),
  VIDEO_FALLBACK_PROVIDER: z.enum(['google', 'runway', 'simulator']).optional(),

  /** Veo, via the Gemini API. Model ids move while it is in preview. */
  GOOGLE_VIDEO_API_KEY: z.string().optional(),
  RUNWAY_API_KEY: z.string().optional(),

  /**
   * Object storage for generated clips. Not optional in production: Veo
   * deletes its copy after 48 hours, so without ours the only artefact of an
   * approved, published advertisement is gone inside two days.
   */
  VIDEO_S3_ENDPOINT: z.string().optional(),
  VIDEO_S3_REGION: z.string().default('eu-central-1'),
  VIDEO_S3_BUCKET: z.string().optional(),
  VIDEO_S3_ACCESS_KEY_ID: z.string().optional(),
  VIDEO_S3_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * How long a playback URL handed to a browser stays valid. Short by design:
   * an unapproved client ad on a guessable URL is the one leak the approval
   * gate cannot prevent.
   */
  VIDEO_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /**
   * Video jobs hold the worker for minutes rather than milliseconds, so they
   * are capped per workspace per tick. Without a cap one busy afternoon in the
   * studio starves the publish queue and scheduled email stops going out.
   */
  VIDEO_MAX_JOBS_PER_TICK: z.coerce.number().int().positive().default(6),

  /* Competitor intelligence --------------------------------------------- */
  /**
   * All optional and independent. Each source that has no key falls back to
   * the simulator and says so on screen; reading public websites needs none.
   */
  COMPANIES_HOUSE_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  COMPETITOR_CRAWL: z.enum(['on', 'off']).default('on'),
  COMPETITOR_RESCAN_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /* Budget Allocator ------------------------------------------------------ */
  /**
   * TrueLayer Data API for reading a company card through UK Open Banking.
   * Live use needs an agency agreement under TrueLayer's AISP permission (or
   * Aurea's own FCA registration) before TRUELAYER_ENV is set to live.
   */
  TRUELAYER_CLIENT_ID: z.string().optional(),
  TRUELAYER_CLIENT_SECRET: z.string().optional(),
  TRUELAYER_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  /**
   * Model and video vendors bill in dollars. Their costs land on the AI and
   * video budget lines converted at this rate until a card charge says
   * exactly what they cost.
   */
  BUDGET_USD_TO_GBP: z.coerce.number().positive().default(0.79),

  /* Commercial ------------------------------------------------------------ */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  APP_URL: z.string().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Env = z.infer<typeof schema>

/**
 * The setting names, without their validation. Exported so a test can check
 * that every one of them is actually written down in .env.example — a feature
 * nobody can find the switch for is a feature that does not exist.
 */
export const ENV_SHAPE = schema.shape

let cached: Env | null = null

export function env(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env.local and fill it in.`)
  }
  cached = parsed.data
  return cached
}

/**
 * True when we have real credentials for the configured provider. When false the
 * gateway transparently uses the deterministic simulator so the product is fully
 * demonstrable without spending a penny.
 */
export function hasLiveModel(): boolean {
  const e = env()
  if (e.AI_PROVIDER === 'mock') return false
  if (e.AI_PROVIDER === 'openai') return Boolean(e.OPENAI_API_KEY)
  if (e.AI_PROVIDER === 'anthropic') return Boolean(e.ANTHROPIC_API_KEY)
  return false
}

export const isProd = () => env().NODE_ENV === 'production'

/** True when email can actually be sent rather than simulated. */
export function hasSendGrid(): boolean {
  const e = env()
  return Boolean(e.SENDGRID_API_KEY && e.SENDGRID_FROM_EMAIL)
}

/** True when SMS can actually be sent rather than simulated. */
export function hasClickSend(): boolean {
  const e = env()
  return Boolean(e.CLICKSEND_USERNAME && e.CLICKSEND_API_KEY)
}

/** True when a blog post can reach the real website rather than the simulator. */
export function hasWordPress(): boolean {
  const e = env()
  return Boolean(e.WORDPRESS_URL && e.WORDPRESS_USERNAME && e.WORDPRESS_APP_PASSWORD)
}

export function deliveryMissing(provider: 'sendgrid' | 'clicksend' | 'wordpress'): string[] {
  const e = env()
  const pairs =
    provider === 'sendgrid'
      ? ([['SENDGRID_API_KEY', e.SENDGRID_API_KEY], ['SENDGRID_FROM_EMAIL', e.SENDGRID_FROM_EMAIL]] as const)
      : provider === 'clicksend'
        ? ([['CLICKSEND_USERNAME', e.CLICKSEND_USERNAME], ['CLICKSEND_API_KEY', e.CLICKSEND_API_KEY]] as const)
        : ([
            ['WORDPRESS_URL', e.WORDPRESS_URL],
            ['WORDPRESS_USERNAME', e.WORDPRESS_USERNAME],
            ['WORDPRESS_APP_PASSWORD', e.WORDPRESS_APP_PASSWORD],
          ] as const)
  return pairs.filter(([, v]) => !v).map(([k]) => k)
}

/** Whether a social platform can actually be connected and posted to. */
export function socialConfigured(provider: 'linkedin' | 'facebook'): boolean {
  const e = env()
  return provider === 'linkedin'
    ? Boolean(e.LINKEDIN_CLIENT_ID && e.LINKEDIN_CLIENT_SECRET)
    : Boolean(e.META_APP_ID && e.META_APP_SECRET)
}

/** Which variables are missing, for the connect screen. */
export function socialMissing(provider: 'linkedin' | 'facebook'): string[] {
  const e = env()
  const pairs =
    provider === 'linkedin'
      ? ([['LINKEDIN_CLIENT_ID', e.LINKEDIN_CLIENT_ID], ['LINKEDIN_CLIENT_SECRET', e.LINKEDIN_CLIENT_SECRET]] as const)
      : ([['META_APP_ID', e.META_APP_ID], ['META_APP_SECRET', e.META_APP_SECRET]] as const)
  return pairs.filter(([, v]) => !v).map(([k]) => k)
}

/** True when generated video reaches a real provider rather than the simulator. */
export function hasLiveVideo(): boolean {
  const e = env()
  if (e.VIDEO_PROVIDER === 'simulator') return false
  if (e.VIDEO_PROVIDER === 'google') return Boolean(e.GOOGLE_VIDEO_API_KEY)
  if (e.VIDEO_PROVIDER === 'runway') return Boolean(e.RUNWAY_API_KEY)
  return false
}

/**
 * Whether a given video provider could serve a request right now. Used by the
 * model picker, so a model nobody can run is shown as needing a key rather
 * than offered and then failing.
 */
export function videoProviderConfigured(provider: 'google' | 'runway' | 'simulator'): boolean {
  const e = env()
  if (provider === 'simulator') return true
  if (provider === 'google') return Boolean(e.GOOGLE_VIDEO_API_KEY)
  return Boolean(e.RUNWAY_API_KEY)
}

/** The environment variable a provider is waiting on, for the picker's hint. */
export function videoProviderKeyName(provider: 'google' | 'runway' | 'simulator'): string | null {
  if (provider === 'google') return 'GOOGLE_VIDEO_API_KEY'
  if (provider === 'runway') return 'RUNWAY_API_KEY'
  return null
}

/** Which credentials the configured video provider is missing. */
export function videoMissing(): string[] {
  const e = env()
  if (e.VIDEO_PROVIDER === 'google' && !e.GOOGLE_VIDEO_API_KEY) return ['GOOGLE_VIDEO_API_KEY']
  if (e.VIDEO_PROVIDER === 'runway' && !e.RUNWAY_API_KEY) return ['RUNWAY_API_KEY']
  return []
}

/**
 * True when the Google Ads API can actually be called. When false every push is
 * routed to the simulator and labelled as such in the audit trail — never
 * silently reported as live.
 */
export function hasGoogleAds(): boolean {
  const e = env()
  return Boolean(
    e.GOOGLE_ADS_DEVELOPER_TOKEN &&
      e.GOOGLE_ADS_CLIENT_ID &&
      e.GOOGLE_ADS_CLIENT_SECRET &&
      e.GOOGLE_ADS_REFRESH_TOKEN,
  )
}

/** Which credentials are missing, for the connection screen. */
export function googleAdsMissing(): string[] {
  const e = env()
  return (
    [
      ['GOOGLE_ADS_DEVELOPER_TOKEN', e.GOOGLE_ADS_DEVELOPER_TOKEN],
      ['GOOGLE_ADS_CLIENT_ID', e.GOOGLE_ADS_CLIENT_ID],
      ['GOOGLE_ADS_CLIENT_SECRET', e.GOOGLE_ADS_CLIENT_SECRET],
      ['GOOGLE_ADS_REFRESH_TOKEN', e.GOOGLE_ADS_REFRESH_TOKEN],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k)
}
