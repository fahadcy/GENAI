/**
 * Guardrail tests. These are pure functions with no database, which is the
 * point: the scoring that gates every asset has to be fast, free and
 * reproducible, or "95% pass unedited" is not a measurable claim.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_LIMITS,
  checkBannedTerms,
  checkChannelLimits,
  checkDisclaimers,
  checkLegal,
  estimateTone,
  flattenBody,
  readability,
  scoreAsset,
  scoreBand,
  TONE_AXES,
} from '../src/lib/ai/guardrails'
import type { LegalRule } from '../src/lib/db/schema'

const rule = (over: Partial<LegalRule> & Pick<LegalRule, 'name' | 'pattern' | 'message'>): LegalRule =>
  ({
    id: over.id ?? 'r1',
    workspaceId: 'ws',
    severity: 'high',
    remedy: null,
    channels: [],
    active: true,
    createdAt: new Date(),
    ...over,
  }) as LegalRule

const profile = {
  tone: { formal: 55, playful: 30, technical: 45, urgent: 25, warm: 55 },
  doList: ['Lead with the concrete problem'],
  dontList: ['Use hype words'],
  bannedTerms: ['guaranteed', 'revolutionary'],
  preferredTerms: [{ avoid: 'leverage', use: 'use' }],
  requiredDisclaimers: [] as { text: string; channels: string[] }[],
  readingLevelMax: 11,
  maxExclamations: 1,
  passThreshold: 80,
}

/* ------------------------------------------------------------ determinism */

test('scoring is deterministic for identical input', () => {
  const body = { subject: 'A clear subject', body: 'Short copy that says a specific thing.' }
  const a = scoreAsset({ body, channel: 'email', profile, legalRules: [] })
  const b = scoreAsset({ body, channel: 'email', profile, legalRules: [] })
  assert.equal(a.composite, b.composite)
  assert.equal(a.brand.score, b.brand.score)
  assert.deepEqual(a.brand.axes, b.brand.axes)
})

/* ------------------------------------------------------------- compliance */

test('a banned term is a high-severity finding that fails the asset', () => {
  const detail = scoreAsset({
    body: { subject: 'Results guaranteed', body: 'This is guaranteed to work.' },
    channel: 'email',
    profile,
    legalRules: [],
  })
  const finding = detail.compliance.findings.find((f) => f.ruleId === 'banned:guaranteed')
  assert.ok(finding, 'expected a banned-term finding')
  assert.equal(finding.severity, 'high')
  assert.equal(detail.passed, false, 'a high-severity finding must fail the asset')
})

test('a high-severity finding fails the asset even at a perfect score', () => {
  // Craft copy that would otherwise score well, then trip one legal rule.
  const detail = scoreAsset({
    body: { subject: 'A measured claim', body: 'We guarantee a specific outcome for your team.' },
    channel: 'email',
    profile: { ...profile, passThreshold: 0 },
    legalRules: [
      rule({ name: 'Guarantee', pattern: '\\bguarantee\\b', message: 'No guarantees.', severity: 'high' }),
    ],
  })
  assert.equal(detail.passed, false)
})

test('legal rules scoped to other channels do not fire', () => {
  const scoped = rule({
    name: 'Competitor',
    pattern: '\\bHubSpot\\b',
    message: 'Needs legal sign-off.',
    severity: 'medium',
    channels: ['google_ads'],
  })
  const text = 'We are not HubSpot.'
  assert.equal(checkLegal(text, [scoped], 'google_ads').length, 1)
  assert.equal(checkLegal(text, [scoped], 'email').length, 0, 'must not fire on an unlisted channel')
})

test('an inactive rule never fires', () => {
  const inactive = rule({ name: 'X', pattern: 'anything', message: 'no', active: false })
  assert.equal(checkLegal('anything at all', [inactive], 'email').length, 0)
})

test('a malformed rule pattern is skipped rather than breaking generation', () => {
  const broken = rule({ name: 'Broken', pattern: '([unclosed', message: 'no' })
  assert.doesNotThrow(() => checkLegal('some text', [broken], 'email'))
  assert.equal(checkLegal('some text', [broken], 'email').length, 0)
})

test('banned terms match whole words only', () => {
  assert.equal(checkBannedTerms('unguaranteed outcomes', ['guaranteed']).length, 0)
  assert.equal(checkBannedTerms('results are guaranteed', ['guaranteed']).length, 1)
})

test('a required disclaimer missing from the channel is a blocking finding', () => {
  const disclaimers = [{ text: 'Results shown are from a pilot programme.', channels: ['google_ads'] }]
  assert.equal(checkDisclaimers('No disclaimer here.', disclaimers, 'google_ads').length, 1)
  assert.equal(checkDisclaimers('No disclaimer here.', disclaimers, 'email').length, 0)
  assert.equal(
    checkDisclaimers('Results shown are from a pilot programme.', disclaimers, 'google_ads').length,
    0,
  )
})

/* ---------------------------------------------------------- channel limits */

test('channel limits are enforced per field', () => {
  const long = 'x'.repeat(300)
  const findings = checkChannelLimits({ body: long }, 'x')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'medium')
  assert.match(findings[0].message, /280/)
})

test('every channel limit references a real field', () => {
  for (const [channel, limits] of Object.entries(CHANNEL_LIMITS)) {
    for (const limit of limits) {
      assert.ok(limit.max > 0, `${channel}.${String(limit.field)} needs a positive max`)
      assert.ok(limit.label.length > 0, `${channel}.${String(limit.field)} needs a label`)
    }
  }
})

/* -------------------------------------------------------------- tone */

test('tone estimation moves in the expected direction', () => {
  const formal = estimateTone(
    'Furthermore, the analysis demonstrates a considerable improvement in operational throughput.',
  )
  const casual = estimateTone("Hey — this is honestly kind of awesome, and it's really fun!")

  assert.ok(formal.formal > casual.formal, 'formal copy should read more formal')
  assert.ok(casual.playful > formal.playful, 'casual copy should read more playful')
})

test('urgency words raise the urgency axis', () => {
  const calm = estimateTone('The report is available when you are ready to read it.')
  const urgent = estimateTone('Last chance — this ends today. Act fast, only 3 places left.')
  assert.ok(urgent.urgent > calm.urgent)
})

test('every tone axis is between 0 and 100', () => {
  const samples = ['', 'Hi!', 'A'.repeat(500), 'Furthermore!!! ' .repeat(30)]
  for (const s of samples) {
    const tone = estimateTone(s)
    for (const axis of TONE_AXES) {
      assert.ok(tone[axis] >= 0 && tone[axis] <= 100, `${axis} out of range for ${JSON.stringify(s.slice(0, 20))}`)
    }
  }
})

test('TONE_AXES covers exactly the profile tone keys', () => {
  assert.deepEqual([...TONE_AXES].sort(), Object.keys(profile.tone).sort())
})

/* -------------------------------------------------------- readability */

test('readability grade rises with sentence and word complexity', () => {
  const simple = readability('The cat sat. The dog ran. We went home.')
  const complex = readability(
    'Notwithstanding the aforementioned considerations, the organisational infrastructure necessitates comprehensive reconfiguration.',
  )
  assert.ok(complex.grade > simple.grade)
})

test('empty text does not divide by zero', () => {
  assert.doesNotThrow(() => readability(''))
  assert.equal(readability('').grade, 0)
})

/* ------------------------------------------------------------- scoring */

test('composite weighting matches the documented 40/45/15 split', () => {
  const detail = scoreAsset({
    body: { subject: 'A subject', body: 'Some plain copy about a specific thing.' },
    channel: 'email',
    profile,
    legalRules: [],
  })
  const expected = Math.round(
    detail.brand.score * 0.4 + detail.compliance.score * 0.45 + detail.readability.score * 0.15,
  )
  assert.equal(detail.composite, expected)
})

test('preferred-term swaps are low severity and do not block', () => {
  const detail = scoreAsset({
    body: { subject: 'Leverage this', body: 'You can leverage the platform today.' },
    channel: 'email',
    profile,
    legalRules: [],
  })
  const finding = detail.compliance.findings.find((f) => f.ruleId === 'preferred:leverage')
  assert.ok(finding)
  assert.equal(finding.severity, 'low')
  assert.ok(!detail.compliance.findings.some((f) => f.severity === 'high'))
})

test('exceeding the exclamation limit is flagged', () => {
  const detail = scoreAsset({
    body: { body: 'Wow! Amazing! Incredible!' },
    channel: 'linkedin',
    profile,
    legalRules: [],
  })
  assert.ok(detail.compliance.findings.some((f) => f.ruleId === 'style:exclamations'))
})

test('scoreBand thresholds line up with the ScoreRing colours', () => {
  assert.equal(scoreBand(90), 'strong')
  assert.equal(scoreBand(85), 'strong')
  assert.equal(scoreBand(84), 'ok')
  assert.equal(scoreBand(70), 'ok')
  assert.equal(scoreBand(69), 'weak')
})

test('flattenBody includes every text-bearing field', () => {
  const text = flattenBody({
    subject: 'S',
    preheader: 'P',
    headline: 'H',
    body: 'B',
    cta: 'C',
    hashtags: ['#tag'],
  })
  for (const part of ['S', 'P', 'H', 'B', 'C', '#tag']) {
    assert.ok(text.includes(part), `missing ${part}`)
  }
})
