/**
 * Email and SMS delivery.
 *
 * These test the two things that cost real money or real trust when they are
 * wrong: the shape of the SendGrid request (a single personalization with many
 * `to` entries would show every recipient's address to every reader, and a
 * shared unsubscribe link would let one person opt everybody out), and phone
 * number normalisation (a malformed number is billed and never delivered).
 *
 * Nothing here touches the network. Both payload builders are pure, which is
 * the reason they were split out of the send functions in the first place.
 */
import '../src/lib/load-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sendGridPayload,
  emailHtml,
  emailText,
  firstNameOf,
  type EmailRecipient,
} from '../src/lib/channels/sendgrid'
import {
  clickSendPayload,
  toE164,
  withStopInstruction,
  smsText,
  segmentsFor,
  type SmsRecipient,
} from '../src/lib/channels/clicksend'

const recipients: EmailRecipient[] = [
  { id: 'c1', email: 'priya@example.com', name: 'Priya Raman' },
  { id: 'c2', email: 'sam@example.co.uk', name: null },
]

const payload = () =>
  sendGridPayload({
    workspaceId: 'ws-1',
    recipients,
    subject: 'When to call an insolvency practitioner',
    html: '<p>Hello</p>',
    text: 'Hello',
    fromEmail: 'hello@cy-group.co.uk',
    fromName: 'CY Group',
    senderName: 'CY Group',
  })

/* ------------------------------------------------------------- SendGrid */

test('every recipient gets their own personalization', () => {
  const p = payload()
  assert.equal(p.personalizations.length, 2)
  for (const person of p.personalizations) {
    assert.equal(person.to.length, 1, 'one address per personalization, or everyone sees everyone')
  }
})

test('no two recipients share an unsubscribe link', () => {
  const p = payload()
  const links = p.personalizations.map((x) => x.substitutions['-unsubscribeUrl-'])
  assert.notEqual(links[0], links[1])
  assert.equal(new Set(links).size, links.length)
})

test('each recipient carries their own one-click header', () => {
  const p = payload()
  const headers = p.personalizations.map((x) => x.headers['List-Unsubscribe'])
  assert.notEqual(headers[0], headers[1])
  assert.ok(headers[0].includes('/api/unsubscribe/'))
  assert.equal(p.personalizations[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
})

test('the unsubscribe placeholder is in the content, not a literal URL', () => {
  // SendGrid substitutes per recipient. A real URL in the shared body would be
  // the same link for all of them.
  const p = payload()
  for (const part of p.content) {
    assert.ok(part.value.includes('-unsubscribeUrl-'), `${part.type} must carry the placeholder`)
  }
})

test('both a text and an HTML part are sent, text first', () => {
  const p = payload()
  assert.deepEqual(
    p.content.map((c) => c.type),
    ['text/plain', 'text/html'],
    'SendGrid requires the plain-text part before the HTML one',
  )
})

test("SendGrid's own bounce and complaint list is never bypassed", () => {
  assert.equal(payload().mail_settings.bypass_list_management.enable, false)
})

test('a nameless contact still gets a usable greeting', () => {
  assert.equal(payload().personalizations[1].substitutions['-firstName-'], 'there')
  assert.equal(firstNameOf('Priya Raman'), 'Priya')
  assert.equal(firstNameOf(null), 'there')
  assert.equal(firstNameOf('   '), 'there')
})

test('model output cannot inject markup into the email', () => {
  const html = emailHtml({
    body: {
      headline: '<img src=x onerror=alert(1)>',
      body: 'Line one\n\nLine two',
      cta: 'Call us',
    },
  } as never)
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
  assert.equal(html.split('<p style=').length - 1, 3, 'two paragraphs plus the CTA')
})

test('the plain-text version keeps the same words', () => {
  const text = emailText({ body: { headline: 'Title', body: 'Body', cta: 'Do it' } } as never)
  assert.equal(text, 'Title\n\nBody\n\nDo it')
})

/* ------------------------------------------------------------ ClickSend */

test('UK numbers reach E.164 from the formats people actually type', () => {
  const expected = '+447700900123'
  for (const raw of [
    '07700 900123',
    '07700900123',
    '+44 7700 900123',
    '+447700900123',
    '00447700900123',
    '447700900123',
    ' 07700-900-123 ',
  ]) {
    assert.equal(toE164(raw), expected, `"${raw}"`)
  }
})

test('a number that cannot be made sense of is refused, not guessed', () => {
  // Refusing costs nothing. Guessing bills for a message nobody receives.
  for (const raw of ['', '   ', 'call me', '12345', '0770', '+1', '0'.repeat(20)]) {
    assert.equal(toE164(raw), null, `"${raw}" should be refused`)
  }
})

test('a non-UK number keeps its own country code', () => {
  assert.equal(toE164('+1 415 555 0132'), '+14155550132')
  assert.equal(toE164('0033 1 42 68 53 00'), '+33142685300')
})

test('STOP is only promised when a reply can actually arrive', () => {
  assert.ok(withStopInstruction('Hello', true).includes('Reply STOP'))
  assert.equal(withStopInstruction('Hello', false), 'Hello')
})

test('a resend does not append STOP twice', () => {
  const once = withStopInstruction('Hello', true)
  assert.equal(withStopInstruction(once, true), once)
})

test('SMS billing is counted the way the carrier counts it', () => {
  assert.equal(segmentsFor('a'.repeat(160)), 1)
  assert.equal(segmentsFor('a'.repeat(161)), 2, 'over 160 it splits and is billed twice')
  assert.equal(segmentsFor('a'.repeat(306)), 2)
  assert.equal(segmentsFor('a'.repeat(307)), 3)
})

test('the SMS body is one line, whatever the asset looked like', () => {
  const text = smsText({
    body: { headline: 'Struggling?  ', body: '\nWe can help.\n\n', cta: 'Call 01782 xxxxxx' },
  } as never)
  assert.equal(text, 'Struggling? We can help. Call 01782 xxxxxx')
  assert.ok(!text.includes('\n'))
})

test('each message is tagged with the contact it belongs to', () => {
  // ClickSend echoes custom_string back, so a rejection points at a person
  // rather than at a bare phone number.
  const list: SmsRecipient[] = [{ id: 'c9', phone: '+447700900123', name: 'Sam' }]
  const p = clickSendPayload({ recipients: list, body: 'Hi', from: 'CYGROUP' })
  assert.equal(p.messages[0].custom_string, 'c9')
  assert.equal(p.messages[0].to, '+447700900123')
  assert.equal(p.messages[0].from, 'CYGROUP')
})

test('no sender ID is sent when none is configured', () => {
  // ClickSend picks the account default. Sending an empty `from` is rejected.
  const p = clickSendPayload({ recipients: [{ id: 'c1', phone: '+447700900123', name: null }], body: 'Hi' })
  assert.ok(!('from' in p.messages[0]))
})
