# GenAI — production image.
#
# Three stages that matter:
#   builder — compiles the app
#   tools   — full toolchain + source; runs migrations, seeding and the worker
#   runner  — the web process only: standalone server output, non-root, no toolchain
#
# The worker and the setup commands need `tsx`, `drizzle-kit` and the `scripts/`
# directory, none of which exist in the standalone output — so they run from
# `tools`, not from `runner`.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
# Dev dependencies are needed downstream (tsx, drizzle-kit), so no --omit=dev here.
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Asks next.config.ts for the self-contained server the runner stage copies.
# Left off outside Docker so a local `npm run build && npm start` works normally.
ENV NEXT_STANDALONE=1
# Placeholders only satisfy env validation during the build; the real values come
# from the runtime environment.
ENV DATABASE_URL="postgres://build:build@localhost:5432/build"
ENV AUTH_SECRET="build-time-placeholder-not-used-at-runtime"
RUN npm run build

# ---------------------------------------------------------------- toolchain
FROM node:22-alpine AS tools
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Default job: publish anything due, on a loop.
CMD ["npx", "tsx", "--conditions=react-server", "scripts/worker.ts", "--loop"]

# --------------------------------------------------------------- web server
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# `public` is committed with a .gitkeep so this COPY never fails on a clean tree.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
