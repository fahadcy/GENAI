/**
 * Publishing to the website.
 *
 * The failures worth testing here are the ones that produce a baffling 401 or
 * 404 rather than a useful message: a site address typed with a trailing
 * slash, an Application Password pasted with the spaces WordPress itself puts
 * in it, and a WordPress installed at /blog rather than at the root. Each of
 * those has cost somebody an afternoon.
 */
import '../src/lib/load-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normaliseSiteUrl,
  postsEndpoint,
  basicAuth,
  blogPayload,
  explainWordPress,
} from '../src/lib/channels/wordpress'

/* ------------------------------------------------------------- the site */

test('a site address survives the ways people type it', () => {
  const expected = 'https://cy-group.co.uk'
  for (const raw of [
    'cy-group.co.uk',
    'https://cy-group.co.uk',
    'https://cy-group.co.uk/',
    '  https://cy-group.co.uk//  ',
  ]) {
    assert.equal(normaliseSiteUrl(raw), expected, `"${raw}"`)
  }
})

test('a WordPress installed in a subfolder keeps its path', () => {
  // Losing the /blog is why the REST API "does not exist".
  assert.equal(normaliseSiteUrl('https://example.co.uk/blog/'), 'https://example.co.uk/blog')
  assert.equal(postsEndpoint('https://example.co.uk/blog/'), 'https://example.co.uk/blog/wp-json/wp/v2/posts')
})

test('nonsense is refused rather than turned into a request', () => {
  for (const bad of ['', '   ', 'localhost', 'not a url']) {
    assert.equal(normaliseSiteUrl(bad), null, `"${bad}"`)
  }
})

test('http is not silently upgraded, but a bare domain defaults to https', () => {
  assert.equal(normaliseSiteUrl('http://example.co.uk'), 'http://example.co.uk')
  assert.equal(normaliseSiteUrl('example.co.uk'), 'https://example.co.uk')
})

/* -------------------------------------------------------------- the auth */

test('an Application Password works whether or not the spaces are pasted', () => {
  // WordPress displays them as "abcd EFGH ijkl MNOP qrst UVWX" and strips the
  // spaces itself before comparing. Not doing the same is a mystery 401.
  const withSpaces = basicAuth('fahad', 'abcd EFGH ijkl MNOP qrst UVWX')
  const without = basicAuth('fahad', 'abcdEFGHijklMNOPqrstUVWX')
  assert.equal(withSpaces, without)
  assert.equal(Buffer.from(without, 'base64').toString(), 'fahad:abcdEFGHijklMNOPqrstUVWX')
})

test('surrounding whitespace on the username is trimmed', () => {
  assert.equal(basicAuth('  fahad  ', 'pass'), basicAuth('fahad', 'pass'))
})

/* -------------------------------------------------------------- the post */

const asset = {
  title: 'When to call an insolvency practitioner',
  body: {
    subject: 'The four signs worth acting on early',
    body: 'First paragraph.\n\nSecond paragraph\nwith a soft break.',
    cta: 'Call us on 01782 000000.',
  },
} as never

test('paragraphs become editable blocks, not one lump of HTML', () => {
  // A bare <p> string lands in WordPress as a single Classic block, which is
  // miserable to edit afterwards.
  const p = blogPayload({ asset, status: 'draft' })
  assert.equal(p.content.split('<!-- wp:paragraph -->').length - 1, 3, 'two paragraphs plus the CTA')
  assert.ok(p.content.includes('<!-- /wp:paragraph -->'))
})

test('a single newline inside a paragraph becomes a line break, not a new block', () => {
  assert.ok(blogPayload({ asset, status: 'draft' }).content.includes('with a soft break'))
  assert.ok(blogPayload({ asset, status: 'draft' }).content.includes('<br>'))
})

test('model output cannot inject markup into the website', () => {
  const nasty = {
    title: 'Fine',
    body: { body: '<script>alert(1)</script>', cta: '' },
  } as never
  const content = blogPayload({ asset: nasty, status: 'draft' }).content
  assert.ok(!content.includes('<script>'))
  assert.ok(content.includes('&lt;script&gt;'))
})

test('the excerpt prefers a written meta description over the opening line', () => {
  assert.equal(blogPayload({ asset, status: 'draft' }).excerpt, 'The four signs worth acting on early')

  const noSubject = { title: 'T', body: { body: 'Opening line.\n\nMore.', cta: '' } } as never
  assert.equal(blogPayload({ asset: noSubject, status: 'draft' }).excerpt, 'Opening line.')
})

test('the requested status is what is sent', () => {
  assert.equal(blogPayload({ asset, status: 'draft' }).status, 'draft')
  assert.equal(blogPayload({ asset, status: 'publish' }).status, 'publish')
})

test('categories are omitted rather than sent empty', () => {
  // An empty categories array moves the post to Uncategorised.
  assert.ok(!('categories' in blogPayload({ asset, status: 'draft', categoryIds: [] })))
  assert.deepEqual(blogPayload({ asset, status: 'draft', categoryIds: [7] }).categories, [7])
})

/* ------------------------------------------------------------ the errors */

test('each WordPress failure is explained as the thing to actually go and fix', () => {
  assert.match(explainWordPress(401), /Application Password/)
  assert.match(explainWordPress(403, 'rest_cannot_create'), /Author or Editor/)
  assert.match(explainWordPress(404, 'rest_no_route'), /\/blog|REST API/)
  assert.match(explainWordPress(429), /rate-limit/)
  assert.match(explainWordPress(503), /temporary/)
})

test('an unrecognised failure still repeats what WordPress said', () => {
  assert.match(explainWordPress(400, 'x', 'Invalid parameter: title'), /Invalid parameter: title/)
})
