import type { NextConfig } from 'next'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pin the build root to this folder.
 *
 * Turbopack infers the root by walking up looking for a lockfile. If one
 * happens to exist higher up — a stray package-lock.json in the Windows user
 * profile is the common case — it warns and can end up scanning far more of the
 * disk than it needs to, which on a synced folder like OneDrive Documents turns
 * a one-minute build into a very long one. Naming the root removes the guess.
 */
const projectRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  turbopack: { root: projectRoot },
  // Same reason, for the file-tracing pass that runs after the build.
  outputFileTracingRoot: projectRoot,
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['postgres'],
  /**
   * Emits .next/standalone — a self-contained server carrying only the modules
   * it actually imports, which is what the Dockerfile copies instead of
   * node_modules.
   *
   * Opt-in rather than always on, because standalone output disables
   * `next start`: Next prints "next start does not work with output:
   * standalone" and tells you to run `node .next/standalone/server.js`, which
   * additionally needs the static assets copied in by hand. That is a fine
   * trade for a container image and a bad one for someone who just wants to run
   * the thing locally without the slow on-demand compiling of dev mode.
   *
   * The Dockerfile sets NEXT_STANDALONE=1. Vercel ignores the setting entirely.
   */
  ...(process.env.NEXT_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts', 'date-fns'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ]
  },
}

export default nextConfig
