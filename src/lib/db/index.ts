import 'server-only'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/lib/env'
import * as schema from './schema'

/**
 * Serverless-safe singleton. Vercel reuses warm lambdas, so we keep one small
 * pool per instance rather than opening a connection per request.
 */
const globalForDb = globalThis as unknown as {
  __genaiSql?: ReturnType<typeof postgres>
}

function client() {
  if (!globalForDb.__genaiSql) {
    globalForDb.__genaiSql = postgres(env().DATABASE_URL, {
      max: process.env.VERCEL ? 1 : 10,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false, // pgbouncer / Supabase transaction pooling compatibility
    })
  }
  return globalForDb.__genaiSql
}

export const db = drizzle(client(), { schema })
export { schema }
export type Db = typeof db
