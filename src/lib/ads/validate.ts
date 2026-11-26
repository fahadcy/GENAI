/**
 * Google's rules, enforced before we ever call Google.
 *
 * Two reasons this is a first-class module rather than a few checks scattered
 * around the push path:
 *
 *  1. The Google Ads API rejects a whole mutate request atomically. One
 *     31-character headline in ad group four and *nothing* gets created, with
 *     an error payload that means nothing to someone who is not a marketer. We
 *     would rather catch it here and say which headline, in which ad group, and
 *     by how many characters.
 *
 *  2. Half of these are editorial policy, not API validation. Google will
 *     happily accept an ad with three exclamation marks and then disapprove it
 *     hours later, after the campaign has been reviewed and enabled by a human
 *     who now thinks the platform is broken.
 *
 * Everything here is a pure function over the plan. No network, no database.
 */
import type { AdCampaignStructure, AdCreative, AdGroupPlan, AdKeyword } from '@/lib/db/schema'

export type Severity = 'error' | 'warning'

export type AdIssue = {
  severity: Severity
  /** Dotted path into the structure, e.g. `adGroups.0.ads.1.headlines.4`. */
  path: string
  /** Human location, e.g. `Ad group "Annual plan" → headline 5`. */
  where: string
  message: string
  /** What the user should do. Always actionable. */
  fix: string
  /** Present when the fix is mechanical, so the UI can offer a one-click repair. */
  suggestion?: string
}

/* ------------------------------------------------------------ Google limits */

export const RSA = {
  headlineMin: 3,
  headlineMax: 15,
  headlineChars: 30,
  descriptionMin: 2,
  descriptionMax: 4,
  descriptionChars: 90,
  pathChars: 15,
} as const

export const KEYWORD = {
  maxChars: 80,
  maxWords: 10,
  /** Google's own recommendation; more than this and ad relevance drops. */
  softMaxPerAdGroup: 20,
} as const

export const CAMPAIGN = {
  nameChars: 255,
  sitelinkTextChars: 25,
  sitelinkDescriptionChars: 35,
  calloutChars: 25,
  minSitelinks: 4,
} as const

/**
 * Google counts characters, and for most double-width scripts counts each
 * character as two. `Array.from` avoids splitting surrogate pairs, so an emoji
 * counts as one character rather than two — which is what Google does too.
 */
export function glyphLength(text: string): number {
  return Array.from(text.trim()).length
}

/* --------------------------------------------------------- editorial policy */

/**
 * Google disallows exclamation marks in headlines entirely, and more than one
 * per ad elsewhere. It also disallows gimmicky repeated punctuation.
 */
const REPEATED_PUNCTUATION = /([!?.,\-*#])\1{1,}/
const GIMMICK_SYMBOLS = /[™®©]{2,}|[★☆●○❤]/

/**
 * All-caps is allowed for acronyms and initialisms, not for emphasis. We treat
 * a run of 3+ capitals as a word, and allow a small allowlist plus anything
 * that looks like an acronym the brand actually uses (2–4 letters).
 */
const ACRONYM_ALLOWANCE = 4

function capsWords(text: string): string[] {
  return (text.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => w.length > ACRONYM_ALLOWANCE)
}

/* ------------------------------------------------------------------ helpers */

const issue = (
  severity: Severity,
  path: string,
  where: string,
  message: string,
  fix: string,
  suggestion?: string,
): AdIssue => ({ severity, path, where, message, fix, suggestion })

/** Trim to a character budget on a word boundary where possible. */
export function trimToLength(text: string, max: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return text.trim()
  const cut = chars.slice(0, max).join('')
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim().replace(/[,\-–—:;]$/, '')
}

/* ------------------------------------------------------------------- creative */

function validateCreative(ad: AdCreative, base: string, groupName: string, adIndex: number): AdIssue[] {
  const found: AdIssue[] = []
  const label = `Ad group "${groupName}" → ad ${adIndex + 1}`

  /* counts */
  if (ad.headlines.length < RSA.headlineMin) {
    found.push(
      issue(
        'error',
        `${base}.headlines`,
        label,
        `Google needs at least ${RSA.headlineMin} headlines; this ad has ${ad.headlines.length}.`,
        `Add ${RSA.headlineMin - ad.headlines.length} more headline${RSA.headlineMin - ad.headlines.length === 1 ? '' : 's'}.`,
      ),
    )
  }
  if (ad.headlines.length > RSA.headlineMax) {
    found.push(
      issue(
        'error',
        `${base}.headlines`,
        label,
        `Google accepts at most ${RSA.headlineMax} headlines; this ad has ${ad.headlines.length}.`,
        `Remove ${ad.headlines.length - RSA.headlineMax}.`,
      ),
    )
  }
  if (ad.headlines.length < 8 && ad.headlines.length >= RSA.headlineMin) {
    found.push(
      issue(
        'warning',
        `${base}.headlines`,
        label,
        `Only ${ad.headlines.length} headlines. Google mixes and matches these, so fewer options means fewer combinations to test.`,
        'Aim for 10–15 headlines. This is the single biggest lever on ad strength.',
      ),
    )
  }
  if (ad.descriptions.length < RSA.descriptionMin) {
    found.push(
      issue(
        'error',
        `${base}.descriptions`,
        label,
        `Google needs at least ${RSA.descriptionMin} descriptions; this ad has ${ad.descriptions.length}.`,
        `Add ${RSA.descriptionMin - ad.descriptions.length} more.`,
      ),
    )
  }
  if (ad.descriptions.length > RSA.descriptionMax) {
    found.push(
      issue(
        'error',
        `${base}.descriptions`,
        label,
        `Google accepts at most ${RSA.descriptionMax} descriptions; this ad has ${ad.descriptions.length}.`,
        `Remove ${ad.descriptions.length - RSA.descriptionMax}.`,
      ),
    )
  }

  /* per-line rules */
  const checkLine = (
    text: string,
    max: number,
    path: string,
    where: string,
    kind: 'headline' | 'description',
  ) => {
    const len = glyphLength(text)
    if (len === 0) {
      found.push(issue('error', path, where, 'This line is empty.', 'Write something or remove the line.'))
      return
    }
    if (len > max) {
      found.push(
        issue(
          'error',
          path,
          where,
          `${len} characters — Google's limit is ${max}. Over by ${len - max}.`,
          'Shorten it. Cutting filler words usually gets there without losing meaning.',
          trimToLength(text, max),
        ),
      )
    }
    if (kind === 'headline' && text.includes('!')) {
      found.push(
        issue(
          'error',
          path,
          where,
          'Google does not allow exclamation marks in headlines.',
          'Remove it — the ad will be disapproved otherwise.',
          text.replace(/!/g, '').replace(/\s+/g, ' ').trim(),
        ),
      )
    }
    if (kind === 'description' && (text.match(/!/g)?.length ?? 0) > 1) {
      found.push(
        issue(
          'warning',
          path,
          where,
          'More than one exclamation mark. Google limits these across an ad.',
          'Keep at most one.',
        ),
      )
    }
    if (REPEATED_PUNCTUATION.test(text)) {
      found.push(
        issue(
          'error',
          path,
          where,
          'Repeated punctuation (like "!!" or "...") is against Google\'s editorial rules.',
          'Use single punctuation.',
          text.replace(/([!?.,\-*#])\1+/g, '$1'),
        ),
      )
    }
    if (GIMMICK_SYMBOLS.test(text)) {
      found.push(
        issue('error', path, where, 'Decorative symbols are not allowed in ad text.', 'Remove them.'),
      )
    }
    const caps = capsWords(text)
    if (caps.length > 0) {
      found.push(
        issue(
          'warning',
          path,
          where,
          `"${caps[0]}" is in capitals. Google allows caps for acronyms, not for emphasis, and will disapprove the ad.`,
          'Use normal sentence case.',
          text.replace(/\b[A-Z]{2,}\b/g, (w) =>
            w.length > ACRONYM_ALLOWANCE ? w[0] + w.slice(1).toLowerCase() : w,
          ),
        ),
      )
    }
  }

  ad.headlines.forEach((h, i) =>
    checkLine(h, RSA.headlineChars, `${base}.headlines.${i}`, `${label} → headline ${i + 1}`, 'headline'),
  )
  ad.descriptions.forEach((d, i) =>
    checkLine(
      d,
      RSA.descriptionChars,
      `${base}.descriptions.${i}`,
      `${label} → description ${i + 1}`,
      'description',
    ),
  )

  /* duplicates — Google rejects identical assets within one ad */
  const seen = new Map<string, number>()
  ad.headlines.forEach((h, i) => {
    const key = h.trim().toLowerCase()
    const first = seen.get(key)
    if (first !== undefined) {
      found.push(
        issue(
          'error',
          `${base}.headlines.${i}`,
          `${label} → headline ${i + 1}`,
          `Identical to headline ${first + 1}. Google rejects duplicate assets in the same ad.`,
          'Rewrite it or remove it.',
        ),
      )
    } else seen.set(key, i)
  })

  /* display paths */
  for (const [key, value] of [
    ['path1', ad.path1],
    ['path2', ad.path2],
  ] as const) {
    if (!value) continue
    if (glyphLength(value) > RSA.pathChars) {
      found.push(
        issue(
          'error',
          `${base}.${key}`,
          `${label} → display path`,
          `"${value}" is ${glyphLength(value)} characters; the limit is ${RSA.pathChars}.`,
          'Shorten it.',
          trimToLength(value, RSA.pathChars),
        ),
      )
    }
    if (/[^a-zA-Z0-9\- ]/.test(value)) {
      found.push(
        issue(
          'error',
          `${base}.${key}`,
          `${label} → display path`,
          'Display paths take letters, numbers and hyphens only.',
          'Remove the other characters.',
          value.replace(/[^a-zA-Z0-9\- ]/g, ''),
        ),
      )
    }
  }

  return found
}

/* ------------------------------------------------------------------ keywords */

function validateKeyword(kw: AdKeyword, base: string, groupName: string, index: number): AdIssue[] {
  const found: AdIssue[] = []
  const where = `Ad group "${groupName}" → keyword ${index + 1}`
  const text = kw.text.trim()

  if (!text) {
    found.push(issue('error', base, where, 'Empty keyword.', 'Remove it.'))
    return found
  }
  if (glyphLength(text) > KEYWORD.maxChars) {
    found.push(
      issue(
        'error',
        base,
        where,
        `"${text}" is ${glyphLength(text)} characters; Google's keyword limit is ${KEYWORD.maxChars}.`,
        'Shorten it.',
        trimToLength(text, KEYWORD.maxChars),
      ),
    )
  }
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > KEYWORD.maxWords) {
    found.push(
      issue(
        'error',
        base,
        where,
        `${words.length} words — Google allows ${KEYWORD.maxWords} per keyword.`,
        'Split it into shorter keywords.',
        words.slice(0, KEYWORD.maxWords).join(' '),
      ),
    )
  }
  if (/[!@%,*]/.test(text)) {
    found.push(
      issue(
        'error',
        base,
        where,
        'Keywords cannot contain ! @ % , or *.',
        'Remove those characters.',
        text.replace(/[!@%,*]/g, '').replace(/\s+/g, ' ').trim(),
      ),
    )
  }
  if (!['EXACT', 'PHRASE', 'BROAD'].includes(kw.matchType)) {
    found.push(
      issue('error', base, where, `Unknown match type "${kw.matchType}".`, 'Use exact, phrase or broad.'),
    )
  }
  return found
}

/* ----------------------------------------------------------------- ad groups */

function validateAdGroup(group: AdGroupPlan, index: number): AdIssue[] {
  const found: AdIssue[] = []
  const base = `adGroups.${index}`
  const label = `Ad group "${group.name || `#${index + 1}`}"`

  if (!group.name?.trim()) {
    found.push(issue('error', `${base}.name`, label, 'Ad group has no name.', 'Give it a short, descriptive name.'))
  }
  if (group.keywords.length === 0) {
    found.push(
      issue(
        'error',
        `${base}.keywords`,
        label,
        'No keywords. The ad group would never show.',
        'Add the searches you want to appear for.',
      ),
    )
  }
  if (group.keywords.length > KEYWORD.softMaxPerAdGroup) {
    found.push(
      issue(
        'warning',
        `${base}.keywords`,
        label,
        `${group.keywords.length} keywords in one ad group. Google's own guidance is around ${KEYWORD.softMaxPerAdGroup}: past that the ads stop matching the searches closely and the cost per click goes up.`,
        'Split the loosest keywords into their own ad group with their own ads.',
      ),
    )
  }
  if (group.ads.length === 0) {
    found.push(issue('error', `${base}.ads`, label, 'No ads in this ad group.', 'Add at least one.'))
  }

  const broadOnly =
    group.keywords.length > 0 && group.keywords.every((k) => k.matchType === 'BROAD')
  if (broadOnly) {
    found.push(
      issue(
        'warning',
        `${base}.keywords`,
        label,
        'Every keyword here is broad match, which lets Google show your ads for anything it judges related.',
        'Keep a few, but make your best-performing terms phrase or exact so spend concentrates where it converts.',
      ),
    )
  }

  group.keywords.forEach((kw, i) => found.push(...validateKeyword(kw, `${base}.keywords.${i}`, group.name, i)))
  group.ads.forEach((ad, i) => found.push(...validateCreative(ad, `${base}.ads.${i}`, group.name, i)))

  return found
}

/* ------------------------------------------------------------------ campaign */

export type CampaignShape = {
  name: string
  finalUrl: string
  dailyBudget: number
  currencyCode: string
  geoTargets: string[]
  languages: string[]
  structure: AdCampaignStructure
  /** From the objective definition, so the budget floor warning is objective-aware. */
  suggestedMinDailyBudget?: number
  conversionAction?: string | null
  objectiveKey?: string
}

export type ValidationReport = {
  ok: boolean
  errors: AdIssue[]
  warnings: AdIssue[]
  /** Everything, in the order found. */
  issues: AdIssue[]
  counts: { adGroups: number; keywords: number; ads: number; headlines: number }
}

export function validateCampaign(shape: CampaignShape): ValidationReport {
  const issues: AdIssue[] = []
  const s = shape.structure

  if (!shape.name?.trim()) {
    issues.push(issue('error', 'name', 'Campaign', 'The campaign has no name.', 'Name it.'))
  } else if (glyphLength(shape.name) > CAMPAIGN.nameChars) {
    issues.push(
      issue(
        'error',
        'name',
        'Campaign',
        `The name is ${glyphLength(shape.name)} characters; Google's limit is ${CAMPAIGN.nameChars}.`,
        'Shorten it.',
        trimToLength(shape.name, CAMPAIGN.nameChars),
      ),
    )
  }

  /* landing page */
  const url = shape.finalUrl?.trim() ?? ''
  if (!url) {
    issues.push(
      issue(
        'error',
        'finalUrl',
        'Campaign',
        'No landing page. Google will not run an ad that goes nowhere.',
        'Add the page people should land on after clicking.',
      ),
    )
  } else {
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    } catch {
      parsed = null
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      issues.push(
        issue(
          'error',
          'finalUrl',
          'Campaign',
          `"${url}" is not a valid web address.`,
          'Use a full address starting with https://',
          url.startsWith('http') ? undefined : `https://${url.replace(/^\/+/, '')}`,
        ),
      )
    } else if (parsed.protocol === 'http:') {
      issues.push(
        issue(
          'warning',
          'finalUrl',
          'Campaign',
          'The landing page is not secure (http, not https). Google penalises this and some browsers warn visitors.',
          'Move the page to https.',
          url.replace(/^http:/, 'https:'),
        ),
      )
    }
  }

  /* money */
  if (!(shape.dailyBudget > 0)) {
    issues.push(
      issue('error', 'dailyBudget', 'Campaign', 'The daily budget is zero.', 'Set a daily budget above zero.'),
    )
  } else if (shape.suggestedMinDailyBudget && shape.dailyBudget < shape.suggestedMinDailyBudget) {
    issues.push(
      issue(
        'warning',
        'dailyBudget',
        'Campaign',
        `${shape.currencyCode} ${shape.dailyBudget}/day is below the ${shape.currencyCode} ${shape.suggestedMinDailyBudget} floor this kind of campaign usually needs. Google's automatic bidding needs roughly 30 results in 30 days before it works properly; under that it is guessing with your money.`,
        `Either raise the budget to ${shape.currencyCode} ${shape.suggestedMinDailyBudget}/day, or narrow the targeting so the same money buys more of the right clicks.`,
      ),
    )
  }

  /* targeting */
  if (shape.geoTargets.length === 0) {
    issues.push(
      issue(
        'error',
        'geoTargets',
        'Campaign',
        'No locations selected, so the ads would show worldwide.',
        'Choose where your customers are.',
      ),
    )
  }
  if (shape.languages.length === 0) {
    issues.push(
      issue('warning', 'languages', 'Campaign', 'No language selected.', 'Pick at least one.', 'en'),
    )
  }

  /* conversion tracking — the difference between advertising and donating */
  if ((shape.objectiveKey === 'sales' || shape.objectiveKey === 'leads') && !shape.conversionAction?.trim()) {
    issues.push(
      issue(
        'warning',
        'conversionAction',
        'Campaign',
        'No conversion is being tracked. Google bids toward results it can measure, so without one it cannot optimise and you cannot tell what worked.',
        'Set up conversion tracking in Google Ads before this goes live — it is the single most important setting on this page.',
      ),
    )
  }

  /* structure */
  if (s.adGroups.length === 0) {
    issues.push(issue('error', 'adGroups', 'Campaign', 'No ad groups.', 'Add at least one.'))
  }
  s.adGroups.forEach((g, i) => issues.push(...validateAdGroup(g, i)))

  /* duplicate ad group names — Google rejects these within a campaign */
  const groupNames = new Map<string, number>()
  s.adGroups.forEach((g, i) => {
    const key = g.name.trim().toLowerCase()
    const first = groupNames.get(key)
    if (key && first !== undefined) {
      issues.push(
        issue(
          'error',
          `adGroups.${i}.name`,
          `Ad group "${g.name}"`,
          `Another ad group already has this name (#${first + 1}).`,
          'Rename one of them.',
        ),
      )
    } else if (key) groupNames.set(key, i)
  })

  /* negatives: the main defence against wasted spend */
  if (s.negativeKeywords.length === 0) {
    issues.push(
      issue(
        'warning',
        'negativeKeywords',
        'Campaign',
        'No negative keywords. These stop your ads showing for searches you do not want — "free", "jobs", "reviews", competitor names.',
        'Add a handful before launch. This is the cheapest money you will save.',
      ),
    )
  }

  /* extensions: free extra space on the results page */
  if (s.sitelinks.length > 0 && s.sitelinks.length < CAMPAIGN.minSitelinks) {
    issues.push(
      issue(
        'warning',
        'sitelinks',
        'Campaign',
        `Only ${s.sitelinks.length} sitelinks. Google usually needs ${CAMPAIGN.minSitelinks} before it shows any.`,
        `Add ${CAMPAIGN.minSitelinks - s.sitelinks.length} more.`,
      ),
    )
  }
  s.sitelinks.forEach((link, i) => {
    if (glyphLength(link.text) > CAMPAIGN.sitelinkTextChars) {
      issues.push(
        issue(
          'error',
          `sitelinks.${i}.text`,
          `Sitelink ${i + 1}`,
          `"${link.text}" is ${glyphLength(link.text)} characters; the limit is ${CAMPAIGN.sitelinkTextChars}.`,
          'Shorten it.',
          trimToLength(link.text, CAMPAIGN.sitelinkTextChars),
        ),
      )
    }
    for (const [key, value] of [
      ['description1', link.description1],
      ['description2', link.description2],
    ] as const) {
      if (value && glyphLength(value) > CAMPAIGN.sitelinkDescriptionChars) {
        issues.push(
          issue(
            'error',
            `sitelinks.${i}.${key}`,
            `Sitelink ${i + 1}`,
            `That line is ${glyphLength(value)} characters; the limit is ${CAMPAIGN.sitelinkDescriptionChars}.`,
            'Shorten it.',
            trimToLength(value, CAMPAIGN.sitelinkDescriptionChars),
          ),
        )
      }
    }
  })
  s.callouts.forEach((c, i) => {
    if (glyphLength(c) > CAMPAIGN.calloutChars) {
      issues.push(
        issue(
          'error',
          `callouts.${i}`,
          `Callout ${i + 1}`,
          `"${c}" is ${glyphLength(c)} characters; the limit is ${CAMPAIGN.calloutChars}.`,
          'Shorten it.',
          trimToLength(c, CAMPAIGN.calloutChars),
        ),
      )
    }
  })

  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues,
    counts: {
      adGroups: s.adGroups.length,
      keywords: s.adGroups.reduce((n, g) => n + g.keywords.length, 0),
      ads: s.adGroups.reduce((n, g) => n + g.ads.length, 0),
      headlines: s.adGroups.reduce((n, g) => n + g.ads.reduce((m, a) => m + a.headlines.length, 0), 0),
    },
  }
}

/* -------------------------------------------------------------- auto-repair */

/**
 * Applies every mechanical suggestion the validator produced. Used by the
 * "fix what you can" button and by the generator, which runs it before showing
 * a plan so the model's occasional over-long headline never reaches the user.
 *
 * Only touches things with an unambiguous fix. Anything needing a decision —
 * too few headlines, no budget, no landing page — is left alone.
 */
export function autoRepair(structure: AdCampaignStructure): {
  structure: AdCampaignStructure
  repaired: number
} {
  let repaired = 0

  const fixText = (text: string, max: number, isHeadline: boolean): string => {
    let out = text.trim()
    if (isHeadline && out.includes('!')) out = out.replace(/!/g, '').replace(/\s+/g, ' ').trim()
    out = out.replace(/([!?.,\-*#])\1+/g, '$1')
    out = out.replace(/\b[A-Z]{2,}\b/g, (w) =>
      w.length > ACRONYM_ALLOWANCE ? w[0] + w.slice(1).toLowerCase() : w,
    )
    if (glyphLength(out) > max) out = trimToLength(out, max)
    if (out !== text) repaired++
    return out
  }

  const adGroups = structure.adGroups.map((g) => ({
    ...g,
    keywords: g.keywords.map((k) => {
      const text = k.text
        .replace(/[!@%,*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, KEYWORD.maxWords)
        .join(' ')
      const clipped = glyphLength(text) > KEYWORD.maxChars ? trimToLength(text, KEYWORD.maxChars) : text
      if (clipped !== k.text) repaired++
      return { ...k, text: clipped }
    }),
    ads: g.ads.map((ad) => {
      const headlines: string[] = []
      const seen = new Set<string>()
      for (const h of ad.headlines) {
        const fixed = fixText(h, RSA.headlineChars, true)
        const key = fixed.toLowerCase()
        if (!fixed || seen.has(key)) {
          repaired++
          continue
        }
        seen.add(key)
        headlines.push(fixed)
      }
      return {
        ...ad,
        headlines: headlines.slice(0, RSA.headlineMax),
        descriptions: ad.descriptions
          .map((d) => fixText(d, RSA.descriptionChars, false))
          .filter(Boolean)
          .slice(0, RSA.descriptionMax),
        path1: ad.path1 ? trimToLength(ad.path1.replace(/[^a-zA-Z0-9\- ]/g, ''), RSA.pathChars) : undefined,
        path2: ad.path2 ? trimToLength(ad.path2.replace(/[^a-zA-Z0-9\- ]/g, ''), RSA.pathChars) : undefined,
      }
    }),
  }))

  return {
    structure: {
      ...structure,
      adGroups,
      sitelinks: structure.sitelinks.map((l) => ({
        ...l,
        text: trimToLength(l.text, CAMPAIGN.sitelinkTextChars),
        description1: l.description1 ? trimToLength(l.description1, CAMPAIGN.sitelinkDescriptionChars) : undefined,
        description2: l.description2 ? trimToLength(l.description2, CAMPAIGN.sitelinkDescriptionChars) : undefined,
      })),
      callouts: structure.callouts.map((c) => trimToLength(c, CAMPAIGN.calloutChars)),
    },
    repaired,
  }
}

/* ------------------------------------------------------------- ad strength */

/**
 * An approximation of Google's Ad Strength, computed locally so the user sees a
 * number before the campaign exists. Google's own score is not available until
 * the ad is uploaded, and it is directional rather than exact — but the inputs
 * are published, and they are the four things that actually move it.
 */
export function adStrength(ad: AdCreative, keywords: AdKeyword[]): {
  score: number
  band: 'poor' | 'average' | 'good' | 'excellent'
  drivers: { label: string; ok: boolean; detail: string }[]
} {
  const unique = new Set(ad.headlines.map((h) => h.trim().toLowerCase())).size
  const terms = keywords.flatMap((k) => k.text.toLowerCase().split(/\s+/)).filter((w) => w.length > 3)
  const withKeyword = ad.headlines.filter((h) =>
    terms.some((t) => h.toLowerCase().includes(t)),
  ).length

  const drivers = [
    {
      label: 'Enough headlines',
      ok: ad.headlines.length >= 10,
      detail: `${ad.headlines.length} of 15. Google mixes these into different combinations — more options, more chances to find the one that works.`,
    },
    {
      label: 'Headlines are distinct',
      ok: unique >= Math.max(6, ad.headlines.length * 0.8),
      detail: `${unique} genuinely different headlines. Near-duplicates give Google nothing new to test.`,
    },
    {
      label: 'Headlines include your keywords',
      ok: withKeyword >= 2 && withKeyword <= Math.ceil(ad.headlines.length * 0.6),
      detail:
        withKeyword < 2
          ? 'None of the headlines contain the words people are searching for.'
          : `${withKeyword} headlines echo the search terms, which is the balance Google looks for.`,
    },
    {
      label: 'Enough descriptions',
      ok: ad.descriptions.length >= 4,
      detail: `${ad.descriptions.length} of 4.`,
    },
  ]

  const score = Math.round((drivers.filter((d) => d.ok).length / drivers.length) * 100)
  const band = score >= 90 ? 'excellent' : score >= 70 ? 'good' : score >= 45 ? 'average' : 'poor'
  return { score, band, drivers }
}
