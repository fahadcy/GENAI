import { sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

/**
 * A table-qualified column reference, for use inside raw `sql` fragments.
 *
 * Why this exists
 * ---------------
 * Interpolating a drizzle column into a `sql` template inside `.select({...})`
 * emits a BARE identifier, not a qualified one:
 *
 *   sql`(select count(*) from assets a where a.brief_id = ${briefs.id})`
 *   → (select count(*) from assets a where a.brief_id = "id")
 *
 * Inside the subquery, unqualified `"id"` binds to the innermost scope — so it
 * resolves to `a.id`, silently returning 0 for every row rather than raising an
 * error. It only appears to work when the inner table happens to have no column
 * of that name.
 *
 * `col()` emits `"table"."column"`, which binds to the outer table as intended.
 * Use it for every column reference inside a correlated subquery.
 */
export function col(column: PgColumn): SQL {
  const table = column.table as unknown as { [k: symbol]: unknown }
  // drizzle stores the SQL table name on a well-known symbol.
  const nameSymbol = Object.getOwnPropertySymbols(table).find(
    (s) => s.description === 'drizzle:Name',
  )
  const tableName = nameSymbol ? String(table[nameSymbol]) : ''
  if (!tableName) {
    throw new Error(`col(): could not resolve the table name for column "${column.name}".`)
  }
  return sql.raw(`"${tableName}"."${column.name}"`)
}
