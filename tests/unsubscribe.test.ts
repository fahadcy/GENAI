/**
 * Opt-out links.
 *
 * This is the one part of the email path with legal weight: UK GDPR and PECR
 * require a working opt-out, and the liability sits with the sender. So these
 * test the properties that make it *work* rather than merely exist — a link
 * that survives a year, cannot be forged to unsubscribe someone else, and
 * cannot be applied twice.
 */
import '../src/lib/load-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  oneClickUrl,
  withUnsubscribeFooter,
  withUnsubscribeText,
  unsubscribeHeaders,
} from '../src/lib/channels/unsubscribe'

const claim = { workspaceId: 'ws-1', contactId: 'contact-9', channel: 'email' as const }

test('a token round-trips to the same claim', () => {
  const parsed = verifyUnsubscribeToken(unsubscribeToken(claim))
  assert.deepEqual(parsed, claim)
})

test('the same claim always produces the same link', () => {
  // Deterministic on purpose: a resend must not invalidate the link in the
  // copy already sitting in someone's inbox.
  assert.equal(unsubscribeToken(claim), unsubscribeToken({ ...claim }))
})

test('you cannot unsubscribe somebody else by editing the link', () => {
  const token = unsubscribeToken(claim)
  const [, mac] = token.split('.')
  const forged = Buffer.from('ws-1.contact-OTHER.email').toString('base64url')
  assert.equal(verifyUnsubscribeToken(`${forged}.${mac}`), null)
})

test('a token from another workspace does not verify against this one', () => {
  const other = unsubscribeToken({ ...claim, workspaceId: 'ws-2' })
  assert.equal(verifyUnsubscribeToken(other)?.workspaceId, 'ws-2')
  assert.notEqual(verifyUnsubscribeToken(other)?.workspaceId, 'ws-1')
})

test('rubbish is refused rather than throwing', () => {
  for (const bad of ['', 'nope', 'a.b.c', '....', 'YWJj.short']) {
    assert.equal(verifyUnsubscribeToken(bad), null, `"${bad}" should be refused`)
  }
})

test('only the three real channels are accepted', () => {
  for (const channel of ['email', 'sms', 'all'] as const) {
    assert.equal(verifyUnsubscribeToken(unsubscribeToken({ ...claim, channel }))?.channel, channel)
  }
  // A token claiming a channel we do not honour must not verify.
  const bogus = Buffer.from('ws-1.contact-9.telepathy').toString('base64url')
  const [, mac] = unsubscribeToken(claim).split('.')
  assert.equal(verifyUnsubscribeToken(`${bogus}.${mac}`), null)
})

/* ------------------------------------------------------------- the links */

test('the human link and the one-click link are different paths', () => {
  // RFC 8058 needs the header URL to accept POST, and a Next page cannot share
  // a path with a route handler — so these must not collide.
  assert.ok(unsubscribeUrl(claim).includes('/unsubscribe/'))
  assert.ok(oneClickUrl(claim).includes('/api/unsubscribe/'))
  assert.notEqual(unsubscribeUrl(claim), oneClickUrl(claim))
})

/* ----------------------------------------------------------- the footer */

const args = { url: 'https://example.com/unsubscribe/abc', senderName: 'CY Group' }

test('the footer goes inside the body, not after the closing tag', () => {
  const html = withUnsubscribeFooter('<html><body><p>Hello</p></body></html>', args)
  assert.ok(html.indexOf('unsubscribe/abc') < html.indexOf('</body>'))
})

test('a body-less fragment still gets a footer', () => {
  assert.ok(withUnsubscribeFooter('<p>Hello</p>', args).includes('unsubscribe/abc'))
})

test('a retried send does not stack two footers', () => {
  const once = withUnsubscribeFooter('<p>Hi</p>', args)
  const twice = withUnsubscribeFooter(once, args)
  assert.equal(twice, once)
  assert.equal(twice.split('Unsubscribe from these emails').length - 1, 1)
})

test('the sender name is escaped, so a workspace name cannot inject markup', () => {
  const html = withUnsubscribeFooter('<p>Hi</p>', {
    ...args,
    senderName: '<script>alert(1)</script>',
  })
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('the plain-text version puts the URL on its own line', () => {
  const text = withUnsubscribeText('Hello there.', args)
  assert.ok(text.includes('\nUnsubscribe: https://example.com/unsubscribe/abc'))
  assert.equal(withUnsubscribeText(text, args), text, 'also idempotent')
})

test('the headers are the pair mail providers require for one-click', () => {
  const h = unsubscribeHeaders('https://example.com/api/unsubscribe/abc')
  assert.equal(h['List-Unsubscribe'], '<https://example.com/api/unsubscribe/abc>')
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
})
