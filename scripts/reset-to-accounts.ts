import '@/lib/load-env'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { eq, ne, sql as raw } from 'drizzle-orm'
import { db } from '@/lib/db'
import { memberships, users, workspaces } from '@/lib/db/schema'
import { hashPassword } from '@/lib/auth/password'

/**
 * Empty the database and put the real team in it.
 *
 * The seed builds a complete worked example — contacts, metrics, campaigns
 * mid-flight — which is right for a demo and wrong for a workspace somebody
 * intends to use. This strips it back so the first real brief is the first
 * thing in the database, then creates the accounts the firm actually uses.
 *
 * Only `workspaces` survives the truncate; the demo users go with everything
 * else. Workspace configuration — brand voice, legal rules, approval chains,
 * the subscription row — is cleared too and is rebuilt in Settings. `plan`
 * lives on `workspaces`, so plan limits keep working.
 *
 * Passwords are generated here and written to `.account-passwords.local`,
 * which is gitignored. They are never printed, because a terminal scrollback
 * is a bad place for a credential. Hand them over one to one and have each
 * person change theirs.
 *
 * This is not reversible.
 */

const TEAM = [
  { email: 'fahad.ali@cy-group.co.uk', name: 'Fahad Ali' },
  { email: 'nicky.harrop@cy-group.co.uk', name: 'Nicky Harrop' },
  { email: 'steve.currie@cy-group.co.uk', name: 'Steve Currie' },
  { email: 'dan.lowndes@cy-group.co.uk', name: 'Dan Lowndes' },
] as const

const ROLE = 'owner' as const
const KEEP = new Set(['workspaces'])

/** Readable but not guessable: four words of base32-ish from real entropy. */
function newPassword(): string {
  return randomBytes(12).toString('base64url').replace(/[-_]/g, '') + '7Aa!'
}

async function main() {
  const before = await counts()
  console.log(`before: ${before.total} rows across ${before.tables} tables\n`)

  /* ---------------------------------------------- 1. clear everything */
  const names = (
    await db.execute<{ table_name: string }>(
      raw`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    )
  )
    .map((r) => r.table_name)
    .filter((t) => !KEEP.has(t) && t !== '__drizzle_migrations')

  await db.execute(raw.raw(`TRUNCATE TABLE ${names.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`))
  console.log(`cleared ${names.length} tables (including the demo accounts)`)

  /* -------------------------------------------- 2. the two workspaces */
  await db.delete(workspaces).where(ne(workspaces.slug, 'cy-group'))
  let [cy] = await db.select().from(workspaces).where(eq(workspaces.slug, 'cy-group'))
  if (!cy) {
    ;[cy] = await db.insert(workspaces).values(workspaceValues('CY Group', 'cy-group')).returning()
  }
  let [el] = await db.select().from(workspaces).where(eq(workspaces.slug, 'easy-liquidation'))
  if (!el) {
    ;[el] = await db
      .insert(workspaces)
      .values(workspaceValues('Easy Liquidation', 'easy-liquidation'))
      .returning()
  }
  console.log(`workspaces: ${cy.name}, ${el.name}`)

  /* -------------------------------------------------- 3. the accounts */
  const secrets: string[] = [
    '# GenAI sign-in details. Generated ' + new Date().toISOString().slice(0, 10) + '.',
    '# Gitignored. Hand these over one to one; have each person change theirs.',
    '',
  ]
  for (const [i, person] of TEAM.entries()) {
    const password = newPassword()
    const [u] = await db
      .insert(users)
      .values({
        email: person.email,
        name: person.name,
        passwordHash: await hashPassword(password),
        avatarHue: 200 + i * 40,
      })
      .returning()
    await db.insert(memberships).values([
      { workspaceId: cy.id, userId: u.id, role: ROLE },
      { workspaceId: el.id, userId: u.id, role: ROLE },
    ])
    secrets.push(`${person.name}`)
    secrets.push(`  ${person.email}`)
    secrets.push(`  ${password}`)
    secrets.push('')
    console.log(`  ${person.email.padEnd(32)} ${ROLE}, both workspaces`)
  }
  writeFileSync('.account-passwords.local', secrets.join('\n'))

  /* ------------------------------------------------------------ report */
  const after = await counts()
  console.log(`\nafter: ${after.total} rows across ${after.tables} tables`)
  console.log('Passwords written to .account-passwords.local (gitignored, not printed here).')
  console.log('Everything else is empty. Set brand voice and an approval chain in Settings.')
}

function workspaceValues(name: string, slug: string) {
  return {
    name,
    slug,
    plan: 'growth' as const,
    seats: 12,
    dataResidency: 'eu',
    settings: {
      defaultTimezone: 'Europe/London',
      weekStartsOn: 1,
      currency: 'GBP',
      requireApprovalAboveSpend: 2500,
    },
  }
}

async function counts() {
  const rows = await db.execute<{ table_name: string }>(
    raw`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
  )
  let total = 0
  let tables = 0
  for (const r of rows) {
    const c = await db.execute<{ n: number }>(raw.raw(`select count(*)::int as n from "${r.table_name}"`))
    const n = Number(c[0]?.n ?? 0)
    if (n > 0) {
      total += n
      tables++
    }
  }
  return { total, tables }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
