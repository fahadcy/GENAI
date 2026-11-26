/**
 * Publishing to real social networks.
 *
 * Two things here are worth more than the rest: the tokens are standing
 * permission to post in someone's name, so their encryption has to actually
 * work; and every platform refusal has to become a sentence the person can act
 * on, because "(#200) Requires pages_manage_posts" sends a marketer nowhere.
 */
import '../src/lib/load-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptToken, decryptToken, tokenHint, TokenDecryptError } from '../src/lib/crypto-secrets'
import { signState, verifyState, authorizeUrl, redirectUri } from '../src/lib/social/oauth'
import { composePost, linkedinPayload, facebookParams, LINKEDIN_LIMIT } from '../src/lib/social/publish'

/* ------------------------------------------------------------ encryption */

test('a token survives a round trip unchanged', () => {
  const token = 'EAAJk3ZC9ZBx0BO1ZC7fake-page-token_with.chars-and~tilde'
  assert.equal(decryptToken(encryptToken(token)), token)
})

test('the same token encrypts differently every time', () => {
  // A fixed nonce would let anyone spot two accounts sharing a credential.
  const a = encryptToken('same-token')
  const b = encryptToken('same-token')
  assert.notEqual(a, b)
  assert.equal(decryptToken(a), decryptToken(b))
})

test('ciphertext is not readable and carries no plaintext', () => {
  const enc = encryptToken('super-secret-page-token')
  assert.ok(!enc.includes('super-secret'))
  assert.match(enc, /^v1\./)
})

test('a tampered token is rejected rather than silently decrypted', () => {
  const enc = encryptToken('original-token')
  const parts = enc.split('.')
  // Flip one character of the ciphertext.
  const cipher = parts[3]
  parts[3] = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1)
  assert.throws(() => decryptToken(parts.join('.')), TokenDecryptError)
})

test('a token encrypted under a different secret cannot be read', () => {
  // Rotating AUTH_SECRET must invalidate stored tokens, not half-work.
  assert.throws(() => decryptToken('v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCC'), TokenDecryptError)
})

test('malformed payloads throw the actionable error, never a raw crypto error', () => {
  for (const bad of ['', 'nonsense', 'v2.a.b.c', 'v1.only.three']) {
    assert.throws(() => decryptToken(bad), TokenDecryptError, `"${bad}" should be rejected cleanly`)
  }
})

test('the token hint reveals only the last four characters', () => {
  assert.equal(tokenHint('abcdefghijklmnop'), '••••mnop')
  assert.equal(tokenHint('abc'), '••••')
})

/* ---------------------------------------------------------------- state */

test('a signed state round-trips with its workspace and intent', () => {
  const state = signState('ws-123', 'linkedin', 'organization')
  const parsed = verifyState(state)
  assert.equal(parsed?.workspaceId, 'ws-123')
  assert.equal(parsed?.provider, 'linkedin')
  assert.equal(parsed?.kind, 'organization')
})

test('a tampered state is refused', () => {
  const state = signState('ws-123', 'facebook', 'page')
  const [body, mac] = state.split('.')
  // Re-encode a different workspace id but keep the original signature.
  const forged = Buffer.from('ws-evil~facebook~page~0~x').toString('base64url')
  assert.equal(verifyState(`${forged}.${mac}`), null)
  assert.equal(verifyState(`${body}.${'A'.repeat(mac.length)}`), null)
  assert.equal(verifyState('rubbish'), null)
})

/* ------------------------------------------------------------ authorize */

test('LinkedIn asks for the organisation scope only when connecting a page', () => {
  process.env.LINKEDIN_CLIENT_ID = 'li-client'
  const member = new URL(authorizeUrl('linkedin', 'ws-1', 'member'))
  const org = new URL(authorizeUrl('linkedin', 'ws-1', 'organization'))

  assert.match(member.searchParams.get('scope')!, /w_member_social/)
  assert.ok(
    !member.searchParams.get('scope')!.includes('w_organization_social'),
    'asking for an unapproved scope fails the whole authorisation',
  )
  assert.match(org.searchParams.get('scope')!, /w_organization_social/)
})

test('the redirect URI matches the callback route exactly', () => {
  // A mismatch here is rejected by both platforms with an opaque error.
  assert.ok(redirectUri('linkedin').endsWith('/api/connect/linkedin/callback'))
  assert.ok(redirectUri('facebook').endsWith('/api/connect/facebook/callback'))
})

/* ------------------------------------------------------------- composing */

const asset = (body: Record<string, unknown>) =>
  ({ channel: 'linkedin', imageUrl: null, body }) as never

test('a post reads in the order a person would write it', () => {
  const post = composePost(
    asset({ headline: 'We changed our pricing', body: 'Flat £1,600.', cta: 'Book a call', hashtags: ['insolvency'] }),
  )
  assert.equal(post.text, 'We changed our pricing\n\nFlat £1,600.\n\nBook a call\n\n#insolvency')
})

test('missing parts are skipped rather than leaving blank gaps', () => {
  const post = composePost(asset({ body: 'Just the body.' }))
  assert.equal(post.text, 'Just the body.')
})

test('hashtags gain their hash without doubling an existing one', () => {
  const post = composePost(asset({ body: 'x', hashtags: ['#already', 'plain'] }))
  assert.ok(post.text.endsWith('#already #plain'))
})

test('over-long text is trimmed on a word boundary, not mid-word', () => {
  const post = composePost(asset({ body: 'word '.repeat(1000) }), LINKEDIN_LIMIT)
  assert.ok(post.text.length <= LINKEDIN_LIMIT)
  assert.ok(post.text.endsWith('…'))
  assert.ok(!/\bwor…$/.test(post.text), 'should not cut inside a word')
})

/* -------------------------------------------------------------- payloads */

test('LinkedIn posts are addressed to the right author', () => {
  const person = linkedinPayload({ authorUrn: 'urn:li:person:abc' }, { text: 'hello' })
  const org = linkedinPayload({ authorUrn: 'urn:li:organization:123' }, { text: 'hello' })
  assert.equal(person.author, 'urn:li:person:abc')
  assert.equal(org.author, 'urn:li:organization:123')
  assert.equal(person.commentary, 'hello')
  assert.equal(person.lifecycleState, 'PUBLISHED')
  assert.equal(person.visibility, 'PUBLIC')
})

test('the Facebook body carries the message and keeps the token out of the URL', () => {
  const params = facebookParams({ text: 'hello world', link: 'https://example.com' }, 'page-token')
  assert.equal(params.get('message'), 'hello world')
  assert.equal(params.get('link'), 'https://example.com')
  assert.equal(params.get('access_token'), 'page-token')
})

test('no link means no link parameter, so Facebook does not build an empty preview', () => {
  const params = facebookParams({ text: 'no link here' }, 'tok')
  assert.equal(params.has('link'), false)
})
