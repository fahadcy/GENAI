/**
 * Kept apart from `client.ts` on purpose.
 *
 * The client is `server-only` — it holds credentials and must never be pulled
 * into a browser bundle. But the error type it throws is also thrown by the
 * simulator and inspected by the UI, neither of which should have to drag the
 * credential-bearing module along to describe a failure.
 */
export type GoogleAdsErrorDetail = {
  status: number
  requestId?: string
  /** Google's own error codes, kept for the audit log and for support. */
  errors: { code: string; message: string; field?: string }[]
  raw?: unknown
  /** True when trying again unchanged is a reasonable thing to do. */
  retryable: boolean
}

export class GoogleAdsError extends Error {
  constructor(
    /** Plain English, safe to show someone who does not work in marketing. */
    message: string,
    readonly detail: GoogleAdsErrorDetail,
  ) {
    super(message)
    this.name = 'GoogleAdsError'
  }
}

/** Shared shape for a mutate response, used by both the client and the simulator. */
export type MutateResponse = {
  mutateOperationResponses?: Record<string, { resourceName?: string }>[]
  partialFailureError?: unknown
}

export type CallResult<T> = { data: T; requestId?: string; status: number }

export type MutateOperation = Record<string, unknown>
