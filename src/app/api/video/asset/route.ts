import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/session'
import { getVideo, verifyPlaybackSignature } from '@/lib/video/storage'

/**
 * Clip playback.
 *
 * Two checks, and both are needed. The signature proves the URL was issued by
 * us and has not expired; the session proves the person asking is signed in.
 * Either alone is not enough — a signed URL that leaks into a shared document
 * should not outlive its expiry, and a signed-in user should not be able to
 * reach another workspace's key, which is why the key is checked against the
 * session's workspace as well as signed.
 *
 * The alternative — public objects in a bucket — is the one leak the approval
 * gate cannot prevent: an unapproved draft advertisement for a client, sitting
 * on a guessable URL.
 *
 * Range requests are answered properly rather than refused. Chromium asks for
 * `bytes=0-` before it will show a single frame, and a reviewer who cannot
 * scrub to the third second of a six-second clip will approve on a first
 * impression instead of a look.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth()
  const url = new URL(request.url)
  const key = url.searchParams.get('key') ?? ''
  const expires = Number(url.searchParams.get('expires') ?? 0)
  const sig = url.searchParams.get('sig') ?? ''

  if (!verifyPlaybackSignature(key, expires, sig)) {
    return NextResponse.json(
      { error: 'This playback link has expired. Reload the page for a fresh one.' },
      { status: 403 },
    )
  }

  // Keys are workspace-scoped by construction; confirm this one belongs to the
  // workspace the session is actually in, so a signature issued for one tenant
  // cannot be replayed against another.
  if (!key.startsWith(`workspaces/${auth.workspace.id}/video/`)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  let bytes: Uint8Array
  try {
    bytes = await getVideo(key)
  } catch {
    return NextResponse.json(
      { error: 'The stored clip could not be read. It may have been removed.' },
      { status: 404 },
    )
  }

  const total = bytes.byteLength
  const range = parseRange(request.headers.get('range'), total)

  const headers: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    // Private: a shared cache must never hold an unapproved clip.
    'cache-control': 'private, max-age=60, must-revalidate',
  }

  if (!range) {
    headers['content-length'] = String(total)
    return new NextResponse(bytes as unknown as BodyInit, { headers })
  }

  if (range === 'unsatisfiable') {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${total}` },
    })
  }

  const slice = bytes.subarray(range.start, range.end + 1)
  headers['content-length'] = String(slice.byteLength)
  headers['content-range'] = `bytes ${range.start}-${range.end}/${total}`
  return new NextResponse(slice as unknown as BodyInit, { status: 206, headers })
}

/**
 * A single byte range, the only form browsers send for media. Multi-range
 * requests are declined by returning null, which is a legal response: the
 * client falls back to asking for the whole file.
 */
function parseRange(header: string | null, total: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number

  if (rawStart === '') {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return 'unsatisfiable'
  }

  return { start, end: Math.min(end, total - 1) }
}
