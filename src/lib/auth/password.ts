import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

/** OWASP-recommended scrypt parameters. No native dependency to build on Vercel. */
const PARAMS = { N: 16384, r: 8, p: 1 }
const KEYLEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/**
 * A hash of a fixed string, used to spend the same work when no user exists.
 * Without it, a missing account returns in microseconds while a real one costs
 * ~100ms of scrypt — a difference an attacker can measure to enumerate valid
 * email addresses.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Burn comparable time, then fail. Never short-circuit on absence.
    await verifyPassword(password, DUMMY_HASH).catch(() => false)
    return false
  }
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, N, r, p, saltB64, keyB64] = parts
  try {
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(keyB64, 'base64')
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = []
  if (password.length < 10) problems.push('Use at least 10 characters.')
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('Mix upper and lower case.')
  if (!/[0-9]/.test(password)) problems.push('Include a number.')
  const common = ['password', '12345678', 'qwerty', 'letmein', 'welcome']
  if (common.some((c) => password.toLowerCase().includes(c))) problems.push('Avoid common words.')
  return problems
}
