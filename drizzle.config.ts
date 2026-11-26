import type { Config } from 'drizzle-kit'
import { config as loadEnv } from './src/lib/env-file'

loadEnv()

export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://genai:genai@127.0.0.1:5432/genai',
  },
  verbose: true,
  strict: false,
} satisfies Config
