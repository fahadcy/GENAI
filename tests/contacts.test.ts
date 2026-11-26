/**
 * Importing a contact list.
 *
 * Two things are being defended here. The parser has to survive what Excel and
 * Google Sheets actually export — quoted commas, embedded newlines, a BOM, CRLF
 * — because a parser that quietly shifts every column one to the left produces
 * a list of phone numbers in the name field and nobody notices until a campaign
 * goes out.
 *
 * And the consent rules have legal weight: the basis someone picks at import
 * time decides whether the platform will send to those people at all, so the
 * mapping from "where the list came from" to "what may be sent" is tested
 * rather than trusted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCsv,
  guessColumns,
  surnameColumn,
  readRows,
  isEmail,
} from '../src/lib/contacts/csv'
import { consentFor, basisEffect, b2bWarnings, BASIS_OPTIONS } from '../src/lib/contacts/consent'

/* ------------------------------------------------------------- parsing */

test('a plain file parses into headers and rows', () => {
  const t = parseCsv('Email,Name\na@b.com,Ann\nc@d.com,Ben\n')
  assert.deepEqual(t.headers, ['Email', 'Name'])
  assert.equal(t.rows.length, 2)
  assert.deepEqual(t.rows[1], ['c@d.com', 'Ben'])
})

test('a quoted field can contain the delimiter', () => {
  const t = parseCsv('Email,Company\na@b.com,"Smith, Jones & Co Ltd"\n')
  assert.deepEqual(t.rows[0], ['a@b.com', 'Smith, Jones & Co Ltd'])
})

test('a quoted field can contain a newline', () => {
  const t = parseCsv('Email,Notes\na@b.com,"line one\nline two"\n')
  assert.equal(t.rows.length, 1, 'the embedded newline must not split the row')
  assert.equal(t.rows[0][1], 'line one\nline two')
})

test('a doubled quote is an escaped quote', () => {
  const t = parseCsv('Email,Company\na@b.com,"The ""Old"" Mill Ltd"\n')
  assert.equal(t.rows[0][1], 'The "Old" Mill Ltd')
})

test('Windows line endings and a UTF-8 BOM do not break the first column', () => {
  // A BOM on the first header is why "Email" sometimes cannot be found.
  const t = parseCsv('﻿Email,Name\r\na@b.com,Ann\r\n')
  assert.deepEqual(t.headers, ['Email', 'Name'])
  assert.deepEqual(guessColumns(t.headers), { email: 0, name: 1 })
})

test('a trailing newline does not create an empty row', () => {
  assert.equal(parseCsv('Email\na@b.com\n').rows.length, 1)
  assert.equal(parseCsv('Email\na@b.com').rows.length, 1)
})

test('a file with no trailing newline still yields its last row', () => {
  const t = parseCsv('Email,Name\na@b.com,Ann')
  assert.deepEqual(t.rows[0], ['a@b.com', 'Ann'])
})

/* ------------------------------------------------------------- mapping */

test('columns are recognised however they are written', () => {
  const map = guessColumns(['Email Address', 'Full Name', 'Mobile Number', 'Company Name', 'Job Title'])
  assert.deepEqual(map, { email: 0, name: 1, phone: 2, company: 3, jobTitle: 4 })
})

test('one column is never claimed by two fields', () => {
  // "Contact" matches both name and phone aliases; whichever wins, not both.
  const map = guessColumns(['Contact', 'Email'])
  const used = Object.values(map)
  assert.equal(new Set(used).size, used.length)
})

test('a first name and surname pair is joined into one name', () => {
  const t = parseCsv('Email,First Name,Surname\na@b.com,Ann,Shah\n')
  const rows = readRows(t, guessColumns(t.headers), { surnameAt: surnameColumn(t.headers) })
  assert.equal(rows.contacts[0].name, 'Ann Shah')
})

test('a file with no recognisable email column is refused with a reason', () => {
  const t = parseCsv('Person,Company\nAnn,Acme\n')
  const out = readRows(t, guessColumns(t.headers))
  assert.equal(out.contacts.length, 0)
  assert.match(out.problems[0].reason, /email column/i)
})

/* ---------------------------------------------------------- validation */

test('bad rows are skipped individually, not the whole file', () => {
  const t = parseCsv(
    ['Email,Name', 'ann@acme.co.uk,Ann', 'not-an-email,Ben', 'cara@acme.co.uk,Cara', ',Dan'].join('\n'),
  )
  const out = readRows(t, guessColumns(t.headers))
  assert.equal(out.contacts.length, 2, 'the two good rows still import')
  assert.equal(out.problems.length, 2)
})

test('a problem points at the line number the spreadsheet shows', () => {
  const t = parseCsv('Email\nann@acme.co.uk\nbroken\n')
  const out = readRows(t, guessColumns(t.headers))
  // Header is line 1, first contact line 2, so the bad one is line 3.
  assert.equal(out.problems[0].line, 3)
})

test('a blank padding row is ignored rather than reported as an error', () => {
  const t = parseCsv('Email,Name\nann@acme.co.uk,Ann\n,\n,\n')
  const out = readRows(t, guessColumns(t.headers))
  assert.equal(out.problems.length, 0)
  assert.equal(out.contacts.length, 1)
})

test('the same address twice in one file becomes one contact', () => {
  const t = parseCsv('Email,Company\nann@acme.co.uk,Old Ltd\nANN@Acme.co.uk,New Ltd\n')
  const out = readRows(t, guessColumns(t.headers))
  assert.equal(out.contacts.length, 1)
  assert.equal(out.duplicatesInFile, 1)
  assert.equal(out.contacts[0].company, 'New Ltd', 'the later row wins')
  assert.equal(out.contacts[0].email, 'ann@acme.co.uk', 'stored lowercase so it matches next time')
})

test('a country column only survives if it is a two-letter code', () => {
  const t = parseCsv('Email,Country\na@b.com,gb\nc@d.com,United Kingdom\n')
  const out = readRows(t, guessColumns(t.headers))
  assert.equal(out.contacts[0].country, 'GB')
  assert.equal(out.contacts[1].country, null, 'better empty than truncated to "UN"')
})

test('an unrecognised lifecycle value falls back to lead', () => {
  const t = parseCsv('Email,Stage\na@b.com,customer\nc@d.com,VIP Platinum\n')
  const out = readRows(t, guessColumns(t.headers))
  assert.equal(out.contacts[0].lifecycleStage, 'customer')
  assert.equal(out.contacts[1].lifecycleStage, 'lead')
})

test('address validation accepts real addresses and rejects the usual rubbish', () => {
  for (const good of ['a@b.co', 'first.last@sub.example.co.uk', "o'brien@acme.com", 'a+tag@b.io']) {
    assert.ok(isEmail(good), good)
  }
  for (const bad of ['', 'plain', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b..com', '@b.com', 'a@.com']) {
    assert.ok(!isEmail(bad), bad)
  }
})

/* ------------------------------------------------------------- consent */

test('every basis says what it switches on, and one switches nothing on', () => {
  assert.equal(BASIS_OPTIONS.length, 4)
  const unknown = consentFor('unknown')
  assert.deepEqual(
    { email: unknown.email, sms: unknown.sms, ads: unknown.ads },
    { email: false, sms: false, ads: false },
    'an unexplained list must not be sendable',
  )
})

test('only an explicit opt-in switches texting on', () => {
  // PECR treats SMS to an individual more strictly than email; the soft
  // opt-in and the B2B position do not carry it.
  assert.equal(consentFor('opt_in').sms, true)
  assert.equal(consentFor('soft_opt_in').sms, false)
  assert.equal(consentFor('b2b_legitimate_interest').sms, false)
})

test('the B2B basis covers email but not ad audiences', () => {
  const c = consentFor('b2b_legitimate_interest')
  assert.equal(c.email, true)
  assert.equal(c.ads, false, 'uploading someone to an ad platform is a further disclosure')
})

test('the basis and the moment it was captured are both recorded', () => {
  const at = new Date('2026-03-01T09:00:00Z')
  const c = consentFor('opt_in', at)
  assert.equal(c.basis, 'opt_in')
  assert.equal(c.capturedAt, at.toISOString())
})

test('an unrecognised basis is treated as unknown rather than as permission', () => {
  const c = consentFor('whatever-they-typed' as never)
  assert.equal(c.email, false)
  assert.equal(c.sms, false)
})

test('the effect of each basis reads as a sentence', () => {
  assert.match(basisEffect('opt_in'), /email, text messages and ad audiences/)
  assert.match(basisEffect('b2b_legitimate_interest'), /^They can be sent email\.$/)
  assert.match(basisEffect('unknown'), /nothing will be sent/i)
})

test('a "business list" full of Gmail addresses is flagged before it is sent to', () => {
  const w = b2bWarnings([
    'ann@acme.co.uk',
    'ben@gmail.com',
    'info@smallco.co.uk',
    'cara@btinternet.com',
  ])
  assert.deepEqual(w.personal, ['ben@gmail.com', 'cara@btinternet.com'])
  assert.deepEqual(w.generic, ['info@smallco.co.uk'])
})
