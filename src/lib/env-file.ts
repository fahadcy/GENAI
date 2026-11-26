/**
 * .env loader for code that runs outside Next's runtime — drizzle-kit, the seed,
 * the worker, the test suites. Next loads .env.local itself for the app.
 *
 * It has to agree with Next's loader on what a line means. An earlier version
 * did not strip inline comments, so
 *
 *     AI_PROVIDER="openai"   # openai | anthropic | mock
 *
 * loaded as the literal string `"openai"   # openai | anthropic | mock` in
 * scripts while the app saw `openai`. That produced a confusing split-brain:
 * the site ran, every script died on validation, and model names were being
 * silently corrupted the same way.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function config(files = ['.env.local', '.env']) {
  for (const file of files) {
    const path = resolve(process.cwd(), file)
    if (!existsSync(path)) continue
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      // First file wins, and a real environment variable always wins.
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

/**
 * Exported for testing. Handles the dotenv conventions that matter here:
 * `export` prefixes, single/double/backtick quoting, escapes inside double
 * quotes, inline comments, and CRLF line endings from Windows editors.
 */
export function parseEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '')
    if (!key) continue

    out[key] = parseValue(line.slice(eq + 1))
  }

  return out
}

function parseValue(rest: string): string {
  const value = rest.trim()
  if (!value) return ''

  const quote = value[0]
  if (quote === '"' || quote === "'" || quote === '`') {
    // Read to the matching close quote; anything after it is a comment.
    const close = value.indexOf(quote, 1)
    if (close !== -1) {
      const inner = value.slice(1, close)
      // Escapes are only meaningful inside double quotes, as in dotenv.
      return quote === '"'
        ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : inner
    }
    // Unterminated quote: treat the remainder as literal rather than throwing.
    return value.slice(1)
  }

  // Unquoted. A `#` starts a comment only when it follows whitespace, so a
  // value that legitimately contains one — a URL fragment, say — survives.
  const comment = value.search(/\s#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}
