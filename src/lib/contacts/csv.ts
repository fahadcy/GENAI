/**
 * Reading a contact list out of a spreadsheet.
 *
 * No `server-only` here on purpose: the same parser runs in the browser to
 * preview an import before anything is written, and on the server to do the
 * writing. Two parsers would eventually disagree, and the disagreement would
 * show up as "the preview said 400 rows and it imported 380".
 *
 * The parsing is deliberately its own step from the mapping, which is its own
 * step from the writing, because every real import goes wrong somewhere in the
 * middle and the person needs to be told *which* middle.
 */

export type CsvTable = { headers: string[]; rows: string[][] }

/**
 * A CSV parser that handles the things Excel actually produces: quoted fields
 * containing commas and newlines, doubled quotes as an escape, CRLF endings,
 * and a UTF-8 BOM that would otherwise make the first column header unmatchable.
 */
export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A trailing newline should not become a row of one empty cell.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < text.length) {
    const c = text[i]

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }

    if (c === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (c === ',') {
      endField()
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      endRow()
      i++
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length > 0) endRow()

  const headers = (rows.shift() ?? []).map((h) => h.trim())
  return { headers, rows }
}

/* ------------------------------------------------------------- mapping */

/** The fields an import can fill. Everything else in the file is ignored. */
export type ContactField =
  | 'email'
  | 'name'
  | 'phone'
  | 'company'
  | 'jobTitle'
  | 'country'
  | 'industry'
  | 'lifecycleStage'

export type ColumnMap = Partial<Record<ContactField, number>>

/**
 * What each field's column is usually called, in the order we prefer them.
 *
 * These are matched loosely — case, spaces and punctuation removed — because
 * "Email Address", "email_address" and "E-mail" are the same column and asking
 * someone to rename their spreadsheet first is how an import gets abandoned.
 */
const ALIASES: Record<ContactField, string[]> = {
  email: ['email', 'emailaddress', 'email address', 'e mail', 'mail', 'workemail', 'contactemail'],
  name: ['name', 'fullname', 'contactname', 'contact', 'firstname', 'first name', 'client', 'clientname'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'telephone', 'tel', 'cell', 'contactnumber'],
  company: ['company', 'companyname', 'organisation', 'organization', 'business', 'account', 'employer'],
  jobTitle: ['jobtitle', 'title', 'role', 'position', 'jobrole'],
  country: ['country', 'countrycode'],
  industry: ['industry', 'sector', 'vertical'],
  lifecycleStage: ['lifecycle', 'lifecyclestage', 'stage', 'status', 'type'],
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Best guess at which column is which, so the common case needs no clicking. */
export function guessColumns(headers: string[]): ColumnMap {
  const cleaned = headers.map(normalise)
  const map: ColumnMap = {}
  const taken = new Set<number>()

  for (const [field, aliases] of Object.entries(ALIASES) as [ContactField, string[]][]) {
    for (const alias of aliases) {
      const idx = cleaned.indexOf(normalise(alias))
      if (idx !== -1 && !taken.has(idx)) {
        map[field] = idx
        taken.add(idx)
        break
      }
    }
  }

  /* A "surname" column next to a "first name" one means the name column found
     above is only half a name. Rather than silently importing first names, the
     two are joined at read time — see `readRow`. */
  return map
}

/** Set when the file has a separate surname column, so the two can be joined. */
export function surnameColumn(headers: string[]): number | null {
  const cleaned = headers.map(normalise)
  for (const alias of ['surname', 'lastname', 'last name', 'familyname']) {
    const idx = cleaned.indexOf(normalise(alias))
    if (idx !== -1) return idx
  }
  return null
}

/* ------------------------------------------------------------ validation */

export type ParsedContact = {
  email: string
  name: string | null
  phone: string | null
  company: string | null
  jobTitle: string | null
  country: string | null
  industry: string | null
  lifecycleStage: string
}

export type RowProblem = {
  /** 1-based, and counting the header, so it matches what the spreadsheet shows. */
  line: number
  email: string
  reason: string
}

export type ImportPreview = {
  contacts: ParsedContact[]
  /** Rows that cannot be imported, each with the reason in plain words. */
  problems: RowProblem[]
  /** Same address more than once in the file: the last one wins, quietly. */
  duplicatesInFile: number
  totalRows: number
}

const LIFECYCLE = new Set(['lead', 'mql', 'sql', 'customer', 'churned', 'evangelist'])

/**
 * Turn mapped rows into contacts, saying exactly why each rejected row failed.
 *
 * Rejections are per-row rather than for the whole file. A list of 500 with
 * three bad addresses should import 497 and name the three — refusing the lot
 * teaches people to strip their own data until it is accepted, which is worse.
 */
export function readRows(table: CsvTable, map: ColumnMap, opts?: { surnameAt?: number | null }): ImportPreview {
  const problems: RowProblem[] = []
  const byEmail = new Map<string, ParsedContact>()
  let duplicatesInFile = 0

  if (map.email === undefined) {
    return {
      contacts: [],
      problems: [{ line: 1, email: '', reason: 'No email column was found or chosen. Every contact needs an address.' }],
      duplicatesInFile: 0,
      totalRows: table.rows.length,
    }
  }

  table.rows.forEach((row, i) => {
    const line = i + 2 // +1 for the header, +1 because spreadsheets count from 1
    const at = (f: ContactField) => {
      const idx = map[f]
      return idx === undefined ? '' : (row[idx] ?? '').trim()
    }

    const email = at('email').toLowerCase()
    if (!email) {
      // A wholly blank row is padding, not an error worth reporting.
      if (row.every((c) => !c.trim())) return
      problems.push({ line, email: '', reason: 'No email address in this row.' })
      return
    }
    if (!isEmail(email)) {
      problems.push({ line, email, reason: 'That is not a valid email address.' })
      return
    }

    let name = at('name')
    const surname = opts?.surnameAt != null ? (row[opts.surnameAt] ?? '').trim() : ''
    if (surname && !name.includes(surname)) name = `${name} ${surname}`.trim()

    const stage = at('lifecycleStage').toLowerCase()
    const country = at('country').toUpperCase()

    const contact: ParsedContact = {
      email,
      name: name || null,
      phone: at('phone') || null,
      company: at('company') || null,
      jobTitle: at('jobTitle') || null,
      // Two letters or nothing: a column holding "United Kingdom" would not fit
      // the column and is better dropped than truncated to "UN".
      country: /^[A-Z]{2}$/.test(country) ? country : null,
      industry: at('industry') || null,
      lifecycleStage: LIFECYCLE.has(stage) ? stage : 'lead',
    }

    if (byEmail.has(email)) duplicatesInFile++
    byEmail.set(email, contact)
  })

  return {
    contacts: [...byEmail.values()],
    problems,
    duplicatesInFile,
    totalRows: table.rows.length,
  }
}

/**
 * Deliberately not RFC 5322. That grammar accepts addresses no mail server
 * will route, and rejecting a valid-but-strange address is a worse failure
 * than accepting one that bounces once.
 */
export function isEmail(value: string): boolean {
  const v = value.trim()
  if (v.length < 6 || v.length > 320 || /\s/.test(v)) return false
  const parts = v.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || local.length > 64) return false
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false
  if (domain.includes('..')) return false
  return /^[^@\s]+$/.test(local) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)
}
