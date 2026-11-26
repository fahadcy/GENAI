import 'server-only'

/**
 * A small JSON client for the card providers. The hosts are fixed (TrueLayer,
 * Airwallex), so none of the SSRF machinery the Competitors crawler needs
 * applies; what matters here is a timeout, and that an error never echoes a
 * token or a card detail back into a log line.
 */

export class CardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: string,
  ) {
    super(message)
    this.name = 'CardApiError'
  }
}

export async function jsonRequest<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    throw new CardApiError(aborted ? `${provider} did not respond in time.` : `Could not reach ${provider}.`, 0, provider)
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>
    const msg = String(b.error_description ?? b.message ?? b.error ?? b.code ?? `HTTP ${res.status}`).slice(0, 200)
    throw new CardApiError(`${provider}: ${msg}`, res.status, provider)
  }
  return body as T
}
