import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * Encryption for stored OAuth tokens.
 *
 * A Facebook Page token obtained from a long-lived user token never expires,
 * and it can post to that Page indefinitely. A LinkedIn token lasts sixty days
 * and can post as the member or the company. These are not passwords — they are
 * standing permission to publish in someone's name — so they do not sit in the
 * database as readable text where a stray `select *`, a log line, a database
 * backup or a support screenshot would expose them.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypting to
 * rubbish. The key is derived from AUTH_SECRET, which the deployment already
 * has to keep secret and already rotates as one unit.
 *
 * Rotating AUTH_SECRET therefore invalidates stored tokens: they cannot be
 * decrypted and the affected accounts show as needing reconnection, which is
 * the correct and honest outcome rather than a silent publishing failure.
 */

const VERSION = 'v1'

function key(): Buffer {
  // A KDF rather than raw bytes: AUTH_SECRET is base64 of arbitrary length,
  // and AES-256 needs exactly 32 bytes.
  return createHash('sha256').update(`aurea:social:${env().AUTH_SECRET}`).digest()
}

/** Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join(
    '.',
  )
}

export class TokenDecryptError extends Error {
  constructor() {
    super(
      'The saved credentials for this account could not be read. This normally means the server secret changed. Reconnect the account to fix it.',
    )
    this.name = 'TokenDecryptError'
  }
}

export function decryptToken(payload: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenDecryptError()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'))
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new TokenDecryptError()
  }
}

/**
 * Last four characters only, for showing which token is stored without
 * revealing it. Never render more than this anywhere.
 */
export function tokenHint(plaintext: string): string {
  return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`
}
