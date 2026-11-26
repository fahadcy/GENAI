import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { env } from '@/lib/env'

/**
 * Storage for generated clips.
 *
 * Two reasons this is not optional in production, and neither is about scale.
 *
 * First, providers delete their copy quickly. Veo removes generated video
 * after 48 hours; Runway's output URLs expire sooner. Without our own copy the
 * only artefact of an approved, published advertisement is gone inside two
 * days — including the one a client might later ask to see.
 *
 * Second, Postgres is the wrong home for 5–50MB blobs, and the audit chain
 * makes that worse rather than better: the database is evidence, it gets
 * backed up, restored and point-in-time recovered, and none of that should be
 * dragging gigabytes of MP4 around with it. The database holds the key, the
 * checksum and the measured facts; the store holds the bytes.
 *
 * Playback is always through a short-lived signed URL. Public objects are not
 * an option: an unapproved draft ad for a client, sitting on a guessable URL,
 * is the one leak the approval gate cannot prevent.
 */

export type StoredObject = {
  key: string
  byteSize: number
  checksumSha256: string
}

export type VideoStoreKind = 'local' | 's3'

/**
 * Keys are workspace-scoped and versioned. The workspace prefix is what makes
 * a per-tenant lifecycle rule or a deletion request possible later without a
 * migration.
 */
export function videoStorageKey(workspaceId: string, generationId: string, version: number): string {
  return `workspaces/${workspaceId}/video/${generationId}/v${version}.mp4`
}

/* ------------------------------------------------------------ local store */

function localRoot(): string {
  return resolve(process.env.VIDEO_LOCAL_STORE_DIR || '.aurea-video-store')
}

function localPath(key: string): string {
  const root = localRoot()
  const full = resolve(join(root, normalize(key)))
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('Storage key escapes the store root.')
  }
  return full
}

/* --------------------------------------------------------------- signing */

/**
 * Signing key for local playback URLs. Derived from AUTH_SECRET so it survives
 * a restart — a reviewer halfway through a queue should not lose their player
 * because the app redeployed.
 */
function signingKey(): string {
  return createHmac('sha256', env().AUTH_SECRET).update('video-playback').digest('hex')
}

export function signPlaybackUrl(key: string, ttlSeconds: number): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = createHmac('sha256', signingKey()).update(`${key}:${expires}`).digest('hex')
  return `/api/video/asset?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`
}

export function verifyPlaybackSignature(key: string, expires: number, sig: string): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false
  const expected = createHmac('sha256', signingKey()).update(`${key}:${expires}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  return a.length === b.length && timingSafeEqual(a, b)
}

/* ------------------------------------------------------------- interface */

export function videoStoreKind(): VideoStoreKind {
  const e = env()
  return e.VIDEO_S3_BUCKET && e.VIDEO_S3_ACCESS_KEY_ID && e.VIDEO_S3_SECRET_ACCESS_KEY ? 's3' : 'local'
}

/**
 * A production deployment with no object store would write clips to an
 * ephemeral container filesystem while the provider deletes its own copy
 * within 48 hours. Better to say so at the point of use than to discover it
 * from an empty player a fortnight later.
 */
export function storageWarning(): string | null {
  if (videoStoreKind() === 's3') return null
  if (env().NODE_ENV !== 'production') return null
  return 'Video is being stored on the local filesystem in production. Clips will be lost on the next deploy, and the provider deletes its own copy within 48 hours. Configure VIDEO_S3_*.'
}

export async function putVideo(key: string, bytes: Uint8Array): Promise<StoredObject> {
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex')

  if (videoStoreKind() === 's3') {
    await s3Put(key, bytes)
  } else {
    const path = localPath(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  return { key, byteSize: bytes.byteLength, checksumSha256 }
}

export async function getVideo(key: string): Promise<Uint8Array> {
  if (videoStoreKind() === 's3') return s3Get(key)
  return new Uint8Array(await readFile(localPath(key)))
}

export async function deleteVideo(key: string): Promise<void> {
  if (videoStoreKind() === 's3') {
    await s3Delete(key)
    return
  }
  await rm(localPath(key), { force: true }).catch(() => {})
}

/* -------------------------------------------------------------------- S3 */

/**
 * The AWS SDK is loaded lazily and is an optional dependency: a deployment
 * running on the simulator with local storage should not have to install it.
 * Works against S3, Cloudflare R2, Backblaze B2 and MinIO.
 */
async function s3Client(): Promise<any> {
  const e = env()
  try {
    const { S3Client } = await import('@aws-sdk/client-s3')
    return new S3Client({
      region: e.VIDEO_S3_REGION,
      endpoint: e.VIDEO_S3_ENDPOINT || undefined,
      // R2, MinIO and B2 all want path-style addressing.
      forcePathStyle: Boolean(e.VIDEO_S3_ENDPOINT),
      credentials: {
        accessKeyId: e.VIDEO_S3_ACCESS_KEY_ID as string,
        secretAccessKey: e.VIDEO_S3_SECRET_ACCESS_KEY as string,
      },
    })
  } catch (cause) {
    throw new Error(
      'VIDEO_S3_* is configured but @aws-sdk/client-s3 is not installed. Run: npm i @aws-sdk/client-s3',
      { cause },
    )
  }
}

async function s3Put(key: string, bytes: Uint8Array): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  const client = await s3Client()
  await client.send(
    new PutObjectCommand({
      Bucket: env().VIDEO_S3_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: 'video/mp4',
      // Recorded on the object as well as in the row, so a restore can be
      // verified against the database rather than trusted.
      Metadata: { sha256: createHash('sha256').update(bytes).digest('hex') },
    }),
  )
}

async function s3Get(key: string): Promise<Uint8Array> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3')
  const client = await s3Client()
  const res = await client.send(new GetObjectCommand({ Bucket: env().VIDEO_S3_BUCKET, Key: key }))
  const chunks: Uint8Array[] = []
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function s3Delete(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
  const client = await s3Client()
  await client.send(new DeleteObjectCommand({ Bucket: env().VIDEO_S3_BUCKET, Key: key }))
}
