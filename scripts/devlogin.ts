/**
 * Dev helper: mint a session cookie for a seeded user without going through the
 * login form, so smoke tests and screenshot runs can hit authenticated routes.
 *
 * Usage: npm run devlogin -- fahad.ali@currieyoung.com
 */
import '../src/lib/load-env'

import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/lib/db'
import { memberships, sessions, users } from '../src/lib/db/schema'

async function main() {
  const email = process.argv[2] ?? 'fahad.ali@currieyoung.com'
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1)
  if (!user) throw new Error(`No user ${email}. Run npm run db:seed first.`)

  const [m] = await db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1)

  const token = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({
    userId: user.id,
    workspaceId: m?.workspaceId ?? null,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 86_400_000),
  })

  process.stdout.write(token)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
