/**
 * Why you are allowed to contact these people.
 *
 * This is the part of a contact list that has legal weight in the UK, and it
 * is the part every simple import screen leaves out. UK GDPR needs a lawful
 * basis for holding the data; PECR separately governs the marketing message
 * itself, and its rules are not the same for email and for SMS, nor the same
 * for a limited company as for a sole trader.
 *
 * Rather than ask "do you have consent? y/n" — a question nobody answers
 * accurately — the import asks where the list came from, and the answer to
 * that decides which channels are switched on. The basis is then stored on
 * every contact, so if the ICO ever asks, the answer is a database column
 * rather than somebody's memory.
 *
 * This encodes the general position and is not legal advice.
 */

export type ConsentBasis = 'opt_in' | 'soft_opt_in' | 'b2b_legitimate_interest' | 'unknown'

export type ConsentState = {
  email: boolean
  sms: boolean
  push: boolean
  ads: boolean
  capturedAt: string
  basis: string
}

export type BasisOption = {
  value: ConsentBasis
  label: string
  /** What this actually means, for someone who is not a marketer. */
  description: string
  /** What it switches on, and why that differs between email and text. */
  grants: { email: boolean; sms: boolean; ads: boolean }
  caution?: string
}

export const BASIS_OPTIONS: BasisOption[] = [
  {
    value: 'opt_in',
    label: 'They asked to hear from us',
    description:
      'They ticked a box, filled in a form, or signed up to a mailing list. This is the strongest position and the only one that covers texting individuals.',
    grants: { email: true, sms: true, ads: true },
  },
  {
    value: 'soft_opt_in',
    label: 'They are an existing client or enquirer',
    description:
      'They bought from you or enquired about your services, you collected the address at that point, and you gave them a way to opt out then and in every message since. Covers marketing about similar services only.',
    grants: { email: true, sms: false, ads: true },
    caution:
      'Texting is left off. The soft opt-in covers email comfortably; for SMS to an individual the safer position is a clear opt-in.',
  },
  {
    value: 'b2b_legitimate_interest',
    label: 'Business contacts at limited companies',
    description:
      'Named people at limited companies or LLPs, where what you are offering is plainly relevant to their job. PECR treats corporate subscribers differently from individuals, and this is the usual basis for B2B email.',
    grants: { email: true, sms: false, ads: false },
    caution:
      'This does not cover sole traders or partnerships — the law treats those as individuals, the same as a personal address. It also does not cover generic inboxes such as info@ or a Gmail address.',
  },
  {
    value: 'unknown',
    label: 'I am not sure',
    description:
      'The contacts are stored, and they can be segmented and reported on, but nothing will be sent to them until you say why you are allowed to.',
    grants: { email: false, sms: false, ads: false },
    caution: 'Nothing is sent. This is the safe answer when a list arrives from somewhere you did not control.',
  },
]

export const BASIS_BY_VALUE = new Map(BASIS_OPTIONS.map((o) => [o.value, o]))

/** The consent object written onto each contact. */
export function consentFor(basis: ConsentBasis, capturedAt = new Date()): ConsentState {
  const option = BASIS_BY_VALUE.get(basis) ?? BASIS_BY_VALUE.get('unknown')!
  return {
    email: option.grants.email,
    sms: option.grants.sms,
    push: false,
    ads: option.grants.ads,
    capturedAt: capturedAt.toISOString(),
    basis,
  }
}

/**
 * One line saying what this basis means for sending, in the present tense.
 * Shown next to the choice, because "legitimate interest" tells a non-marketer
 * nothing about whether their campaign will actually go out.
 */
export function basisEffect(basis: ConsentBasis): string {
  const g = (BASIS_BY_VALUE.get(basis) ?? BASIS_BY_VALUE.get('unknown')!).grants
  const on = [g.email && 'email', g.sms && 'text messages', g.ads && 'ad audiences'].filter(Boolean) as string[]
  if (on.length === 0) return 'Stored, but nothing will be sent to them yet.'
  const list = on.length === 1 ? on[0] : `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}`
  return `They can be sent ${list}.`
}

/**
 * Business-looking addresses in a list declared as B2B.
 *
 * A free-mail or generic address is the giveaway that a "business list" has
 * consumers or shared inboxes in it, and it is exactly what an ICO complaint
 * is built on. This does not block the import — it warns, before it happens.
 */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'live.co.uk', 'live.com', 'aol.com', 'icloud.com', 'me.com', 'msn.com',
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'protonmail.com', 'proton.me',
])

const GENERIC_LOCAL = new Set([
  'info', 'sales', 'enquiries', 'enquiry', 'contact', 'admin', 'hello', 'office',
  'accounts', 'support', 'mail', 'team', 'help', 'general', 'reception',
])

export function b2bWarnings(emails: string[]): { personal: string[]; generic: string[] } {
  const personal: string[] = []
  const generic: string[] = []
  for (const e of emails) {
    const [local, domain] = e.toLowerCase().split('@')
    if (!domain) continue
    if (FREE_MAIL.has(domain)) personal.push(e)
    else if (GENERIC_LOCAL.has(local)) generic.push(e)
  }
  return { personal, generic }
}
