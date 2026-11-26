/**
 * The paid-advertising engine.
 *
 * These matter more than most tests in this codebase because the failure mode
 * is other people's money. A campaign that is subtly wrong does not throw — it
 * runs, spends, and produces nothing, and nobody finds out for a fortnight.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateCampaign,
  autoRepair,
  adStrength,
  trimToLength,
  glyphLength,
  RSA,
} from '../src/lib/ads/validate'
import { buildCampaignOperations, readMutateResponse, todayInTimeZone, normaliseMatchType } from '../src/lib/ads/google/build'
import { simulateMutate } from '../src/lib/ads/google/simulator'
import { toMicros, fromMicros, budgetExplanation, objectiveDef, OBJECTIVES } from '../src/lib/ads/objectives'
import type { AdCampaignStructure } from '../src/lib/db/schema'

/* ------------------------------------------------------------- fixtures */

const goodAd = {
  headlines: [
    'Commercial roofing',
    'Roof repairs in Leeds',
    'Free roof survey',
    'Fixed price quotes',
    'Emergency callout',
    'Fully insured roofers',
    'Flat roofs and pitched',
    '25 year guarantee',
    'Talk to a roofer today',
    'No call centre',
    'Local, family run',
    'Book a survey online',
  ],
  descriptions: [
    'Commercial roof repairs across Leeds and West Yorkshire. Fixed prices, no surprises.',
    'Free survey, honest advice, and a written quote within two working days.',
    'Fully insured, guaranteed workmanship, and a real person on the end of the phone.',
    'Get a quote today and see how straightforward it can be.',
  ],
  path1: 'roofing',
}

const structure: AdCampaignStructure = {
  adGroups: [
    {
      name: 'Commercial roofing — ready to buy',
      theme: 'People ready to book work.',
      keywords: [
        { text: 'commercial roofing', matchType: 'EXACT' },
        { text: 'commercial roof repair quote', matchType: 'PHRASE' },
        { text: 'flat roof repair leeds', matchType: 'PHRASE' },
      ],
      ads: [goodAd],
    },
  ],
  negativeKeywords: [{ text: 'free', matchType: 'BROAD', reason: 'No commercial intent.' }],
  sitelinks: [
    { text: 'Get a quote', description1: 'Free and no obligation.', finalUrl: 'https://example.com/quote' },
    { text: 'About us', finalUrl: 'https://example.com/about' },
    { text: 'Our work', finalUrl: 'https://example.com/work' },
    { text: 'Contact', finalUrl: 'https://example.com/contact' },
  ],
  callouts: ['Free survey', 'Fully insured', '25 year guarantee'],
  rationale: 'Split by intent.',
}

const shape = {
  name: 'Commercial roofing — Leeds',
  finalUrl: 'https://example.com/quote',
  dailyBudget: 40,
  currencyCode: 'GBP',
  geoTargets: ['2826'],
  languages: ['1000'],
  structure,
  suggestedMinDailyBudget: 20,
  conversionAction: 'customers/1/conversionActions/1',
  objectiveKey: 'leads',
}

/* ------------------------------------------------------------ validator */

test('a well-formed campaign passes with no errors', () => {
  const report = validateCampaign(shape)
  assert.equal(report.ok, true, report.errors.map((e) => e.message).join('; '))
  assert.equal(report.counts.adGroups, 1)
  assert.equal(report.counts.keywords, 3)
})

test('a headline one character over the limit is an error, and says by how much', () => {
  const long = 'A'.repeat(RSA.headlineChars + 1)
  const report = validateCampaign({
    ...shape,
    structure: withHeadlines([...goodAd.headlines.slice(0, 11), long]),
  })
  assert.equal(report.ok, false)
  const found = report.errors.find((e) => e.message.includes('Over by 1'))
  assert.ok(found, 'should name the overage')
  assert.equal(glyphLength(found!.suggestion!), RSA.headlineChars)
})

test('an exclamation mark in a headline is rejected — Google disallows it outright', () => {
  const report = validateCampaign({ ...shape, structure: withHeadlines([...goodAd.headlines, 'Call us today!']) })
  assert.ok(report.errors.some((e) => e.message.includes('exclamation')))
  const fix = report.errors.find((e) => e.message.includes('exclamation'))!.suggestion
  assert.equal(fix, 'Call us today')
})

test('duplicate headlines are caught, because Google rejects the whole ad for one', () => {
  const report = validateCampaign({
    ...shape,
    structure: withHeadlines([...goodAd.headlines, 'commercial roofing']),
  })
  assert.ok(report.errors.some((e) => e.message.includes('Identical to headline 1')))
})

test('SHOUTING is flagged but acronyms are left alone', () => {
  const report = validateCampaign({
    ...shape,
    structure: withHeadlines([...goodAd.headlines.slice(0, 10), 'AMAZING roofing deals', 'VAT included']),
  })
  const caps = report.warnings.filter((w) => w.message.includes('in capitals'))
  assert.equal(caps.length, 1, 'AMAZING flagged, VAT not')
  assert.ok(caps[0].message.includes('AMAZING'))
})

test('a campaign with no landing page cannot pass', () => {
  const report = validateCampaign({ ...shape, finalUrl: '' })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((e) => e.path === 'finalUrl'))
})

test('a budget under the objective floor warns but does not block', () => {
  const report = validateCampaign({ ...shape, dailyBudget: 5 })
  assert.equal(report.ok, true, 'a low budget is the user\'s call, not an error')
  const warn = report.warnings.find((w) => w.path === 'dailyBudget')
  assert.ok(warn?.message.includes('30 results in 30 days'))
})

test('no locations is an error — worldwide targeting is never what anyone meant', () => {
  assert.equal(validateCampaign({ ...shape, geoTargets: [] }).ok, false)
})

test('a sales campaign with no conversion tracking is warned about specifically', () => {
  const report = validateCampaign({ ...shape, objectiveKey: 'sales', conversionAction: null })
  assert.ok(report.warnings.some((w) => w.path === 'conversionAction'))
})

test('a keyword with more than ten words is rejected and truncated in the suggestion', () => {
  const report = validateCampaign({
    ...shape,
    structure: {
      ...structure,
      adGroups: [
        {
          ...structure.adGroups[0],
          keywords: [{ text: 'one two three four five six seven eight nine ten eleven', matchType: 'PHRASE' }],
        },
      ],
    },
  })
  const err = report.errors.find((e) => e.message.includes('11 words'))
  assert.ok(err)
  assert.equal(err!.suggestion!.split(' ').length, 10)
})

/* ---------------------------------------------------------- auto-repair */

test('autoRepair fixes what it can and leaves judgement calls alone', () => {
  const broken: AdCampaignStructure = {
    ...structure,
    adGroups: [
      {
        ...structure.adGroups[0],
        ads: [
          {
            headlines: [
              'This headline is far too long to ever fit in Google',
              'Call now!!',
              'AMAZING VALUE HERE',
              'Commercial roofing',
              'commercial roofing',
            ],
            descriptions: ['Short enough.', 'Also fine.'],
          },
        ],
      },
    ],
  }
  const { structure: fixed, repaired } = autoRepair(broken)
  const ad = fixed.adGroups[0].ads[0]

  assert.ok(repaired > 0)
  for (const h of ad.headlines) assert.ok(glyphLength(h) <= RSA.headlineChars, `"${h}" still too long`)
  assert.ok(!ad.headlines.some((h) => h.includes('!')), 'exclamation marks removed')
  assert.ok(!ad.headlines.some((h) => /\b[A-Z]{5,}\b/.test(h)), 'shouting normalised')
  assert.equal(new Set(ad.headlines.map((h) => h.toLowerCase())).size, ad.headlines.length, 'duplicates dropped')
  // Two descriptions is below Google's minimum, but adding one is a writing
  // decision, not a mechanical fix — repair must not invent copy.
  assert.equal(ad.descriptions.length, 2)
})

test('trimToLength cuts on a word boundary rather than mid-word', () => {
  assert.equal(trimToLength('Commercial roofing services in Leeds', 25), 'Commercial roofing')
  assert.equal(trimToLength('Short', 25), 'Short')
})

/* --------------------------------------------------------- ad strength */

test('ad strength rewards more distinct headlines', () => {
  const thin = adStrength({ headlines: ['One', 'Two', 'Three'], descriptions: ['a', 'b'] }, [])
  const full = adStrength(goodAd, structure.adGroups[0].keywords)
  assert.ok(full.score > thin.score)
  assert.ok(['good', 'excellent'].includes(full.band), `got ${full.band}`)
})

/* ------------------------------------------------------------- objectives */

test('micros conversion is exact at the penny', () => {
  assert.equal(toMicros(40), 40_000_000)
  assert.equal(toMicros(12.34), 12_340_000)
  assert.equal(fromMicros(toMicros(99.99)), 99.99)
})

test('the budget explanation states both Google ceilings, not just the daily one', () => {
  const { sentence, monthlyMax, dailyMax } = budgetExplanation(40, 'GBP')
  assert.equal(dailyMax, 80)
  assert.equal(Math.round(monthlyMax), 1216)
  assert.ok(sentence.includes('£80'))
  assert.ok(sentence.includes('£1,216'))
})

test('every objective maps to a channel and a bidding strategy', () => {
  for (const o of OBJECTIVES) {
    assert.ok(o.channelType)
    assert.ok(o.biddingStrategy)
    assert.ok(o.suggestedMinDailyBudget > 0)
    assert.equal(objectiveDef(o.key).key, o.key)
  }
})

/* ------------------------------------------------------------ payload */

const buildInput = {
  customerId: '1234567890',
  campaignName: 'Commercial roofing — Leeds',
  channelType: 'SEARCH' as const,
  biddingStrategy: 'MAXIMIZE_CONVERSIONS' as const,
  dailyBudgetMicros: 40_000_000,
  targetCpaMicros: 25_000_000,
  startDate: '2026-09-01',
  geoTargets: ['2826'],
  languages: ['1000'],
  finalUrl: 'https://example.com/quote',
  conversionAction: 'customers/1234567890/conversionActions/99',
  structure,
}

test('the budget is created before the campaign that references it', () => {
  const ops = buildCampaignOperations(buildInput)
  const budgetAt = ops.findIndex((o) => 'campaignBudgetOperation' in o)
  const campaignAt = ops.findIndex((o) => 'campaignOperation' in o)
  assert.ok(budgetAt >= 0 && campaignAt > budgetAt, 'ordering matters — Google resolves temp ids in order')
})

test('search partners and the display network are switched off', () => {
  const ops = buildCampaignOperations(buildInput)
  const campaign = (ops.find((o) => 'campaignOperation' in o) as any).campaignOperation.create
  assert.equal(campaign.networkSettings.targetSearchNetwork, false)
  assert.equal(campaign.networkSettings.targetContentNetwork, false)
  assert.equal(campaign.networkSettings.targetGoogleSearch, true)
})

test('a campaign is always built paused', () => {
  const ops = buildCampaignOperations(buildInput)
  const campaign = (ops.find((o) => 'campaignOperation' in o) as any).campaignOperation.create
  assert.equal(campaign.status, 'PAUSED')
})

test('exactly one bidding strategy field is set', () => {
  for (const strategy of ['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'MAXIMIZE_CLICKS'] as const) {
    const ops = buildCampaignOperations({ ...buildInput, biddingStrategy: strategy })
    const campaign = (ops.find((o) => 'campaignOperation' in o) as any).campaignOperation.create
    const set = ['maximizeConversions', 'maximizeConversionValue', 'targetSpend', 'targetCpa', 'targetRoas'].filter(
      (k) => k in campaign,
    )
    assert.equal(set.length, 1, `${strategy} set ${set.join(', ')}`)
  }
})

test('money crosses the wire as a string, because micros exceed float precision in JSON', () => {
  const ops = buildCampaignOperations(buildInput)
  const budget = (ops.find((o) => 'campaignBudgetOperation' in o) as any).campaignBudgetOperation.create
  assert.equal(typeof budget.amountMicros, 'string')
  assert.equal(budget.amountMicros, '40000000')
})

test('negative keywords are attached to the campaign, not to one ad group', () => {
  const ops = buildCampaignOperations(buildInput)
  const negatives = ops.filter(
    (o: any) => o.campaignCriterionOperation?.create?.negative === true,
  )
  assert.equal(negatives.length, structure.negativeKeywords.length)
})

test('every sitelink asset is linked to the campaign', () => {
  const ops = buildCampaignOperations(buildInput)
  const assets = ops.filter((o: any) => o.assetOperation?.create?.sitelinkAsset)
  const links = ops.filter((o: any) => o.campaignAssetOperation?.create?.fieldType === 'SITELINK')
  assert.equal(assets.length, structure.sitelinks.length)
  assert.equal(links.length, structure.sitelinks.length)
})

test('readMutateResponse pulls the campaign and budget back out', () => {
  const parsed = readMutateResponse({
    mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: 'customers/1/campaignBudgets/11' } },
      { campaignResult: { resourceName: 'customers/1/campaigns/22' } },
      { adGroupResult: { resourceName: 'customers/1/adGroups/33' } },
      { adGroupAdResult: { resourceName: 'customers/1/adGroupAds/33~44' } },
    ],
  })
  assert.equal(parsed.budget, 'customers/1/campaignBudgets/11')
  assert.equal(parsed.campaign, 'customers/1/campaigns/22')
  assert.deepEqual(parsed.adGroups, ['customers/1/adGroups/33'])
  assert.deepEqual(parsed.ads, ['customers/1/adGroupAds/33~44'])
})

test('todayInTimeZone returns the date Google expects, in the account time zone', () => {
  // 00:30 on the 2nd in London is still the 1st in Los Angeles.
  const instant = new Date('2026-09-02T00:30:00Z')
  assert.equal(todayInTimeZone('Europe/London', instant), '2026-09-02')
  assert.equal(todayInTimeZone('America/Los_Angeles', instant), '2026-09-01')
})

test('unknown match types fall back to phrase rather than throwing at Google', () => {
  assert.equal(normaliseMatchType('exact'), 'EXACT')
  assert.equal(normaliseMatchType('nonsense'), 'PHRASE')
})

/* ----------------------------------------------------------- simulator */

test('the simulator accepts a valid payload and returns resource names', () => {
  const ops = buildCampaignOperations(buildInput)
  const result = simulateMutate(ops, { customerId: '1234567890', seed: 'stable' })
  assert.equal(result.data.mutateOperationResponses?.length, ops.length)
  const campaign = result.data.mutateOperationResponses!.find((r) => 'campaignResult' in r)
  assert.match(campaign!.campaignResult!.resourceName!, /^customers\/1234567890\/campaigns\/\d+$/)
})

test('the simulator is deterministic — the same campaign yields the same ids', () => {
  const ops = buildCampaignOperations(buildInput)
  const a = simulateMutate(ops, { customerId: '1234567890', seed: 'abc' })
  const b = simulateMutate(ops, { customerId: '1234567890', seed: 'abc' })
  assert.deepEqual(a.data, b.data)
})

test('validateOnly creates nothing, exactly as Google behaves', () => {
  const ops = buildCampaignOperations(buildInput)
  const result = simulateMutate(ops, { customerId: '1234567890', validateOnly: true })
  assert.equal(result.data.mutateOperationResponses, undefined)
})

test('the simulator rejects an operation that references something not yet created', () => {
  const ops = buildCampaignOperations(buildInput)
  // Move the campaign ahead of its budget: the exact mistake a refactor makes.
  const budgetIndex = ops.findIndex((o) => 'campaignBudgetOperation' in o)
  const campaignIndex = ops.findIndex((o) => 'campaignOperation' in o)
  const reordered = [...ops]
  ;[reordered[budgetIndex], reordered[campaignIndex]] = [reordered[campaignIndex], reordered[budgetIndex]]

  assert.throws(
    () => simulateMutate(reordered, { customerId: '1234567890' }),
    (e: any) => /not created earlier in the request/.test(e.detail.errors[0].message),
  )
})

test('the simulator catches an over-long headline that slipped past the validator', () => {
  const ops = buildCampaignOperations({
    ...buildInput,
    structure: withHeadlines([...goodAd.headlines.slice(0, 11), 'X'.repeat(40)]),
  })
  assert.throws(
    () => simulateMutate(ops, { customerId: '1234567890' }),
    (e: any) => e.detail.errors.some((x: any) => x.code === 'StringLengthError.TOO_LONG'),
  )
})

test('the simulator fails the whole request, not part of it', () => {
  const ops = buildCampaignOperations({ ...buildInput, dailyBudgetMicros: 0 })
  assert.throws(
    () => simulateMutate(ops, { customerId: '1234567890' }),
    (e: any) => e.detail.status === 400 && !e.detail.retryable,
  )
})

test('a zero budget never reaches Google', () => {
  const ops = buildCampaignOperations({ ...buildInput, dailyBudgetMicros: 0 })
  assert.throws(
    () => simulateMutate(ops, { customerId: '1234567890' }),
    (e: any) => e.detail.errors[0].code === 'CampaignBudgetError.INVALID_BUDGET_AMOUNT',
  )
})

/* ------------------------------------------------------------- helpers */

function withHeadlines(headlines: string[]): AdCampaignStructure {
  return {
    ...structure,
    adGroups: [
      { ...structure.adGroups[0], ads: [{ ...goodAd, headlines }] },
    ],
  }
}
