/**
 * Tests for the .env parser.
 *
 * This exists because a real bug shipped here: inline comments were not
 * stripped, so `AI_PROVIDER="openai"  # openai | anthropic | mock` loaded with
 * the comment attached. The app was fine — Next has its own loader — but every
 * script failed validation, and model names were being silently corrupted the
 * same way. The two loaders have to agree on what a line means.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEnv } from '../src/lib/env-file'
import { ENV_SHAPE } from '../src/lib/env'

test('strips an inline comment after a quoted value', () => {
  const env = parseEnv('AI_PROVIDER="openai"          # openai | anthropic | mock')
  assert.equal(env.AI_PROVIDER, 'openai')
})

test('strips an inline comment after an unquoted value', () => {
  assert.equal(parseEnv('AI_MODEL_FAST=gpt-4o-mini   # cheap loops').AI_MODEL_FAST, 'gpt-4o-mini')
})

test('keeps a # that is part of the value', () => {
  // No preceding whitespace, so it is not a comment marker.
  assert.equal(parseEnv('URL=https://example.com/page#section').URL, 'https://example.com/page#section')
  assert.equal(parseEnv('PASSWORD="a#b#c"').PASSWORD, 'a#b#c')
})

test('handles the three quote styles', () => {
  assert.equal(parseEnv('A="double"').A, 'double')
  assert.equal(parseEnv("B='single'").B, 'single')
  assert.equal(parseEnv('C=`backtick`').C, 'backtick')
})

test('a connection string with special characters survives intact', () => {
  const line =
    'DATABASE_URL="postgresql://alex:AbC%23123@ep-cool-a1b2.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"'
  assert.equal(
    parseEnv(line).DATABASE_URL,
    'postgresql://alex:AbC%23123@ep-cool-a1b2.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  )
})

test('a base64 secret ending in = is not truncated', () => {
  const secret = '91oclGeFeW5+qcU6f7i3tZrjJX9bofVd99w80VKwo4Q='
  assert.equal(parseEnv(`AUTH_SECRET="${secret}"`).AUTH_SECRET, secret)
  assert.equal(parseEnv(`AUTH_SECRET=${secret}`).AUTH_SECRET, secret)
})

test('CRLF line endings from a Windows editor parse cleanly', () => {
  const env = parseEnv('A="one"\r\nB="two"\r\n')
  assert.equal(env.A, 'one')
  assert.equal(env.B, 'two')
})

test('skips comment lines and blank lines', () => {
  const env = parseEnv(['# a comment', '', '   ', 'A=1', '# B=2'].join('\n'))
  assert.equal(env.A, '1')
  assert.equal(env.B, undefined)
})

test('accepts an export prefix', () => {
  assert.equal(parseEnv('export A="value"').A, 'value')
})

test('an empty value stays empty rather than becoming undefined', () => {
  assert.equal(parseEnv('OPENAI_API_KEY=""').OPENAI_API_KEY, '')
  assert.equal(parseEnv('OPENAI_API_KEY=').OPENAI_API_KEY, '')
})

test('escapes are expanded in double quotes only', () => {
  assert.equal(parseEnv('A="line1\\nline2"').A, 'line1\nline2')
  assert.equal(parseEnv("B='line1\\nline2'").B, 'line1\\nline2')
})

test('an unterminated quote does not throw', () => {
  assert.doesNotThrow(() => parseEnv('A="oops'))
  assert.equal(parseEnv('A="oops').A, 'oops')
})

test('the shipped .env.example parses to usable values', () => {
  // The exact file the user copies to .env.local — comments and all.
  const example = [
    'DATABASE_URL="postgres://user:password@host:5432/genai"',
    'AUTH_SECRET="change-me-to-a-long-random-string-min-24-chars"',
    'AI_PROVIDER="openai"          # openai | anthropic | mock',
    'OPENAI_API_KEY=""',
    'AI_MODEL_FAST="gpt-4o-mini"   # scoring, classification, cheap loops',
    'AI_MODEL_SMART="gpt-4o"       # generation, planning, segment interpretation',
  ].join('\n')

  const env = parseEnv(example)
  assert.equal(env.AI_PROVIDER, 'openai', 'must satisfy the AI_PROVIDER enum')
  assert.equal(env.AI_MODEL_FAST, 'gpt-4o-mini', 'a corrupted model name would fail at the provider')
  assert.equal(env.AI_MODEL_SMART, 'gpt-4o')
  assert.equal(env.OPENAI_API_KEY, '')
})

test('every setting the app knows about is documented in .env.example', () => {
  /* The failure this catches is a quiet one: a feature is wired up, the
     variable works on the machine it was written on, and nobody else can turn
     it on because nothing ever told them the name. */
  const file = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  const documented = new Set([
    ...Object.keys(parseEnv(file)),
    // Commented-out lines still count as documented: they are optional
    // settings shown with an explanation of when to uncomment them.
    ...(file.match(/^#\s*([A-Z][A-Z0-9_]+)=/gm) ?? []).map((m) => m.replace(/^#\s*/, '').replace(/=$/, '')),
  ])

  // NODE_ENV is set by Next and the tooling, never by hand.
  const known = Object.keys(ENV_SHAPE).filter((k) => k !== 'NODE_ENV')
  const missing = known.filter((k) => !documented.has(k))
  assert.deepEqual(missing, [], `undocumented settings: ${missing.join(', ')}`)
})
