# GenAI

**One governed loop from brief to result.**

GenAI is a GenAI marketing platform built to the *GenAI Marketing Automation*
product requirements (v1.0, August 2026). A campaign is generated, reviewed,
approved, published and optimised inside one pipeline, with every step on a
tamper-evident record.

The wedge is not "AI writes copy". Point tools already do that. It is the
connective tissue: the model that writes the email is connected to the model
that decides who receives it and when, and to the data that says whether it
worked — and none of it can reach a customer without passing a gate.

---

## Quick start

```bash
cp .env.example .env.local     # set DATABASE_URL and AUTH_SECRET
npm install
npm run setup                  # push the schema, then seed a full demo workspace
npm run dev
```

Open http://localhost:3000 and sign in with any seeded account
(password `GenAI2026!`):

| Email | Role | Lands on |
| --- | --- | --- |
| `fahad.ali@currieyoung.com` | Owner | Command Center |
| `priya@currieyoung.com` | Growth marketer | Campaign Planner |
| `marcus@currieyoung.com` | Content creator | Content Studio |
| `elena@currieyoung.com` | Reviewer / legal | Approvals queue |
| `daniel@currieyoung.com` | Marketing ops | Command Center |
| `grace@currieyoung.com` | Analyst | Performance |

Signing in as each of these is the fastest way to see what role-aware
governance actually means — the same workspace looks materially different to a
creator, a reviewer and an analyst.

### It runs without an API key

Leave `OPENAI_API_KEY` empty and the model gateway falls back to a deterministic
simulator. Generation, planning and audience interpretation all still produce
sensible, channel-correct output; scoring, approvals, scheduling, publishing and
the copilot are unaffected because none of them need a model. Add a key and the
same code paths call the provider instead. The UI says which is in use.

---

## What is built

| Surface | Requirement | What it does |
| --- | --- | --- |
| **Command Center** | CC-1…4 | Portfolio KPIs, the live five-stage pipeline per campaign, the "needs you" queue, and ranked copilot recommendations |
| **Content Studio** | CS-1…5 | Brief → channel-shaped variants, each scored before a human reads it; inline editing with re-scoring, versioning, regeneration |
| **Campaign Planner** | CP-1…5 | Objective → sequenced plan; timeline, board and calendar over the same data; dependency-aware slip recalculation; reusable templates |
| **Audience Targeting** | AT-1…5 | Plain-language audiences compiled to editable rules over real contacts; lookalikes; consent and suppression enforced in the engine |
| **Google Ads** | — | A sentence in, a complete Search campaign out: ad groups, keywords with match types, responsive search ads, negative keywords and extensions — validated against Google's real limits, governed by the same approval chains, and pushed to Google as a single atomic mutate, paused |
| **Competitors** | — | Finds local and UK-wide competitors (Companies House, Google Maps, who ranks and advertises on your searches), reads each one's site, blog, ads, rankings and reviews, and turns the gaps into plays that open Content Studio, Google Ads or Video Studio prefilled. Generators can be steered by the landscape; competitors are never named in copy, and the guardrail flags it if they are |
| **Approvals** | AP-1…5 | Configurable chains, one-click decisions with required rejection comments, word-level diffs on re-review, delegation, hash-chained audit |
| **Scheduler** | SC-1…5 | One cross-channel calendar with drag-to-reschedule, AI send-time selection with its reasoning, blackout windows, frequency caps, retry and dead-letter |
| **Performance** | PF-1…5 | Channel scorecard tied to spend and pipeline, fatigue detection, AI-vs-manual send-time attribution, CSV export |
| **Settings** | NFR | Brand voice profile with a live test panel, legal rules, chain builder, members, connectors, billing, audit viewer with integrity verification |

---

## Architecture

```
src/
  app/
    (marketing)/        public landing and pricing
    (auth)/             sign in, sign up
    (app)/              the product — one directory per surface
    api/                health check, cron publish tick
    actions/            server actions shared across surfaces
  components/           design system, then one folder per surface
  lib/
    ai/
      gateway.ts        model gateway: provider abstraction, tiering,
                        structured-output validation, caching, metering,
                        deterministic fallback
      guardrails.ts     brand + legal scoring (pure, no I/O, unit-tested)
      agents/           content, planner, segment interpretation, ads
    ads/
      objectives.ts     business goal → Google configuration, in code
      validate.ts       Google's limits and editorial rules (pure, unit-tested)
      push.ts           gate → validate → build → dry run → atomic create
      google/
        client.ts       version-pinned REST client, OAuth, error translation
        build.ts        campaign → mutate payload (pure, unit-tested)
        simulator.ts    payload-level stand-in that fails what Google fails
    workflow/
      approvals.ts      chain matching, decisions, the publish gate
      subjects.ts       what the approval engine needs to know about a subject
      audit.ts          hash-chained append-only trail + verification
    scheduler/
      schedule.ts       conflict checks and placement
      sendtime.ts       send-time model with an explainable rationale
      publish.ts        delivery with backoff, retry and dead-letter
    targeting/
      engine.ts         rules → SQL, consent enforcement, lookalikes
    copilot/
      analyze.ts        detection from real metrics
      apply.ts          apply + exact undo
    connectors/         one adapter interface, simulated implementations
    db/                 schema, client, SQL helpers
```

### Decisions worth knowing

**The guardrail is deterministic and free.** Brand and legal scoring is pure
functions over text — no model call. That is what makes "95% of assets pass the
brand check unedited" a measurable claim rather than a slogan, and what lets
every asset be scored before a human ever sees it.

**The audit trail is hash-chained.** Each event stores
`sha256(prevHash ‖ canonical(event))`. Editing or deleting any historical row
breaks every hash after it, and `verifyChain` names the sequence number where
the break occurs. A hash chain cannot stop a database owner editing a row; it
makes the edit *detectable*, which is the honest version of the promise.
`tests/audit.test.ts` tampers with history deliberately and asserts detection.

**The gate is checked twice.** Once when an asset is scheduled, and again by the
publisher at send time — because an approval can be revoked, or the asset
edited, in between. Approval is bound to a version: edit an approved asset and
the approval is void until it is reviewed again.

**Consent lives in the engine, not the caller.** `evaluateRules` and
`refreshSegment` are the only ways to size or materialise an audience, and both
exclude suppressed contacts and honour per-channel consent. There is no code
path that can accidentally target someone who opted out.

**The copilot finds problems with arithmetic, not a model.** Creative fatigue,
cost-per-acquisition gaps, send-time drift and approval bottlenecks are all
computed from the workspace's own metric rows. That is what lets every
recommendation carry evidence a marketer can check. A model is used later, only
to write the replacement asset once a human accepts.

**Paid campaigns go through the same approval engine as organic content**, via
a small subject adapter rather than a second implementation. The alternative —
copying the decision logic for campaigns — would mean two implementations of
"nothing publishes without a completed chain", and the second one would drift.
A campaign reports its monthly ceiling as its spend, so a spend-threshold chain
set at £1,000 correctly catches a £40/day campaign.

**Nothing this platform sends to Google is ever enabled.** A campaign is created
paused, in one atomic mutate, after a dry run that asks Google to validate the
whole thing and create nothing. Enabling it is a separate action, restricted to
owners and marketing ops, requiring an explicit confirmation that states the
daily figure, the 2× busy-day figure and the 30.4× monthly ceiling — and the
client passes the figure it displayed back to the server, which refuses if the
budget changed in between.

**The ad validator speaks English, not error codes.** Google rejects a mutate
atomically: one 31-character headline in ad group four and nothing is created,
with a payload that means nothing to someone who does not work in marketing. So
the rules are enforced before the call, and each finding carries where it is,
what is wrong, what to do, and — where the fix is mechanical — the corrected
text. Roughly half of them are editorial policy rather than API validation,
which Google accepts and then disapproves hours later.

**Every copilot action captures its undo before mutating**, so revert restores
the prior state rather than approximating it. Both directions are audited with
`actorType: 'copilot'`.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit and integration tests (needs `DATABASE_URL`) |
| `npm run db:push` | Sync the schema to the database |
| `npm run db:seed` | Rebuild the demo workspace |
| `npm run setup` | `db:push` then `db:seed` |
| `npm run worker` | Publish anything due, once |
| `npm run worker -- --loop` | Long-running publish worker |

Scripts that run outside Next use `--conditions=react-server` so `server-only`
imports resolve. That is already wired into the npm scripts.

---

## Deployment

### Vercel + managed Postgres

1. Import the repository.
2. Set `DATABASE_URL`, `AUTH_SECRET` (`openssl rand -base64 32`), and
   `OPENAI_API_KEY` if you want live generation. Set `CRON_SECRET` too.
3. Deploy, then run `npm run db:push` against the production database once.

`vercel.json` registers a cron that calls `/api/cron/publish` every five
minutes; the route requires `Authorization: Bearer $CRON_SECRET` and refuses
unauthenticated requests in production.

Neon, Supabase and Vercel Postgres all work. The client sets `prepare: false`,
so transaction-mode connection pooling is supported.

### Just running it locally

```bash
npm run build     # ~1 minute, compiles everything once
npm start         # every page then loads instantly
```

Prefer this over `npm run dev` unless you are editing the code. Dev mode compiles
each page the first time you open it, which on Windows can take minutes per route
and looks like it has hung. `npm run build` does the same work once, with a
progress indicator, and `npm start` serves prebuilt pages.

### Windows

Two environment problems cost more time than anything in this codebase, and both
are worth fixing once:

**Do not keep the project in OneDrive.** `Documents` is redirected to OneDrive on
most Windows installs, and OneDrive tries to sync all ~40,000 files in
`node_modules`. That slows every install and build, and locks files mid-operation
so moves and deletes fail. Keep it somewhere OneDrive does not touch, e.g.
`C:\dev\genai`.

**Exclude the folder from Defender.** Real-time scanning inspects every file the
build touches. In an elevated PowerShell:

```powershell
Add-MpPreference -ExclusionPath "C:\dev"
```

Also check for a stray `package-lock.json` in your user profile
(`C:\Users\<you>`). If one exists, Next warns that it cannot tell where the
project root is. This config pins the root either way, but the stray file is
worth renaming.

### Docker

```bash
docker compose up --build -d
docker compose run --rm setup     # push the schema, seed the demo workspace
# open http://localhost:3000
```

Brings up Postgres, the web app and a separate publish worker, so scheduled
delivery never competes with request handling.

The image is multi-stage. `runner` carries only the standalone server output and
runs as a non-root user — no toolchain, no source. `setup` and `worker` run from
a `tools` stage instead, because both need `tsx`, `drizzle-kit` and the
`scripts/` directory, none of which exist in the standalone output.

Useful afterwards:

```bash
docker compose logs -f worker     # watch the publish queue
docker compose run --rm setup npm run db:seed   # reset the demo data
curl localhost:3000/api/health    # liveness + database reachability
```

---

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres 14+ |
| `AUTH_SECRET` | yes | 24+ characters |
| `AI_PROVIDER` | no | `openai` (default), `anthropic`, `mock` |
| `OPENAI_API_KEY` | no | Blank runs the simulator |
| `AI_MODEL_FAST` / `AI_MODEL_SMART` | no | Per-task model tiering |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | no | All four Google variables are needed together; without them the ads engine runs its own builder and checker |
| `GOOGLE_ADS_CLIENT_ID` / `_SECRET` | no | OAuth client for the `adwords` scope |
| `GOOGLE_ADS_REFRESH_TOKEN` | no | Obtained once through the consent flow |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | no | Manager (MCC) account, digits only |
| `LINKEDIN_CLIENT_ID` / `_SECRET` | no | Personal posting is self-serve; company pages need LinkedIn approval |
| `META_APP_ID` / `META_APP_SECRET` | no | Facebook Pages only — Meta forbids posting to personal profiles |
| `STRIPE_SECRET_KEY` | no | Without it, billing runs in catalogue-only mode |
| `CRON_SECRET` | production | Required to authorise the cron route |

Configuration is validated at boot by `src/lib/env.ts`; anything missing fails
loudly with a message naming the variable rather than at 3am inside a worker.

---

## Testing

```bash
npm test
```

Seven suites, all against the real engine — no mocks of the logic under test:

- `guardrails.test.ts` — scoring determinism, severity handling, channel limits,
  tone estimation, the documented 40/45/15 composite weighting
- `audit.test.ts` — chain integrity, tamper and deletion detection, concurrent
  appends, CSV escaping
- `pipeline.test.ts` — the full Generate → Review → Approve → Publish walk, plus
  every gate: blocking findings, unapproved scheduling, forced override,
  post-approval edits, multi-step chains, consent enforcement, tenant isolation
- `targeting.test.ts` — every rule operator, nested groups, per-channel
  reachability, lookalike expansion, natural-language translation safety
- `ads.test.ts` — Google's ad limits and editorial rules, the mechanical
  repairer, the mutate payload builder (operation ordering, one bidding strategy,
  networks off, always paused, money as a string), and the simulator's rejection
  of payloads Google would reject
- `env-file.test.ts` — the `.env` parser, which has to agree with Next's own
  loader on what a line means
- `social.test.ts` — token encryption round-trip and tamper detection, OAuth
  state signing, scope selection, post composition and both platforms' payloads
- `provider-params.test.ts` — which parameters go to which OpenAI model family

Each database test builds and destroys its own workspace, so the suite never
touches seeded demo data and tenant isolation is exercised as a side effect.

---

## What is simulated, and what is not

Being straight about this matters more than a longer feature list.

**Real:** the data model, tenant isolation, RBAC, brand and legal scoring, the
approval engine and its gates, the hash-chained audit trail, segment compilation
and consent enforcement, send-time modelling, scheduling conflict detection,
retry and dead-letter handling, copilot detection and undo, usage metering, and
every figure shown in the UI.

**Simulated:** outbound delivery. Connectors implement one adapter interface;
the bundled implementations validate payloads the way a real API would, apply
channel constraints, and fail a small fraction of calls with realistic retryable
errors so the retry and dead-letter paths are genuinely exercised. Swapping in
SendGrid or LinkedIn means implementing that interface — nothing upstream
changes.

**LinkedIn and Facebook are real when connected.** Both are ordinary OAuth
connections made in Settings; tokens are encrypted with AES-256-GCM keyed from
`AUTH_SECRET` and only ever decrypted inside the publisher. A channel with no
connected account keeps using the simulator and says so. What differs is the
approval each platform demands, and it is worth knowing before planning around
it: posting as a LinkedIn *person* is self-serve, posting as a LinkedIn *company
page* needs the Community Management API and a manual review measured in months,
Facebook Pages work in development for Pages your own app admins administer, and
posting to a client's Page needs App Review plus Business Verification. Facebook
does not permit posting to personal profiles at any tier.

**Google Ads specifically.** The client is a real, version-pinned REST client
against `v25`, and it is what runs the moment the four credentials are present.
Until then the same built payload goes to a simulator that walks the operation
list the way Google's server does — resolving temporary resource ids, checking
every cross-reference, enforcing the field limits, and failing the whole request
atomically with Google's own error vocabulary. This exists because a developer
token needs a manager account and a manual review that takes days, and a
test-level token cannot touch a real account at all; the product has to be
usable in that window. Every simulated push is stored with `simulated: true` and
labelled as such wherever it appears. Nothing is ever presented as live when it
was not.

**Not built:** live OAuth flows for each vendor, an email transport for
invitations (they produce a copyable link), and Stripe checkout (the plan
catalogue and metering are there; the payment call is not).


---

## Competitor intelligence

`/competitors`. Set up once (company, what you do, the searches customers use,
local or national), then **Find competitors** and **Rescan and analyse**.

- **Discovery** (`lib/competitors/discover.ts`, `discovery.ts`): Companies House
  same-SIC companies, Google Places near your postcode and UK-wide, and who ranks
  and advertises on your searches. Merged into one record per business, scored
  0–100 with readable reasons, split direct / indirect, local / national.
  Ported from the WebAppTest prototype, with its SIC guard rails.
- **Scans** (`collect.ts`): website and blog (robots.txt obeyed, extracts only),
  search ads with their copy, organic positions, Google reviews, YouTube, news,
  Companies House facts. Each source fails alone and says why. Stored with sha256.
- **Analysis** (`analysis.ts`, pure): claim matrix, share of search, content gaps,
  customer pain points from low-star reviews, channel activity, threat score,
  change detection between scans, and **plays**. The AI agent writes positioning,
  competitive advantage and how to win, and must cite evidence ids.
- **Into the rest of GenAI**: a "Use competitor intelligence" switch in Content
  Studio and the Google Ads builder (stored with the brief/campaign as
  provenance); competitor brands become negative keywords; the guardrail flags
  copy naming a competitor or making a comparative claim (CAP Code 3.33–3.44).
- **Monitoring**: the worker and `/api/cron/competitors` rescan tracked
  competitors every `COMPETITOR_RESCAN_DAYS` and notify on notable changes.

Every source is optional (see `.env.example`). With none, a labelled simulated
market is used; competitors added by web address are always read for real.
