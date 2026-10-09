# Ehud Radar

Marketing workspace for Ehud AI. Shared-account login and manual prospect management are implemented. Discovery with optional AI fit assessment is implemented. Prospect research, communication drafts, and manual outreach tracking are implemented.

## Run locally

Requires Node.js 22.12 or newer, npm, and PostgreSQL.

```sh
npm install
npm run db:local
npm run dev
```

`db:local` uses PostgreSQL 17 installed on this Mac. Set `PG_BIN` for another installation. It creates a dedicated cluster inside ignored `data/postgres`, listens only on `127.0.0.1:5433`, creates the `ehud_radar` database, and generates database credentials, a session secret, and a setup token in `.env` if that file does not exist. Existing configuration is preserved. It does not set the account password.

Open `http://127.0.0.1:5174`, rather than the HTML file directly. The API runs on port 3002.

## Choose your password

```sh
npm run setup:link
```

Open the local link printed by that command. The username is fixed to **ehudaiuser**. Enter and confirm a password, then select **Create password & enter**. Use at least 12 characters and no more than 72 UTF-8 bytes. The password is stored as a bcrypt hash. The setup link contains a private token; keep it local. Setup cannot replace an existing password or create another account.

After setup, use the regular frontend URL to sign in. Sessions persist across API restarts, last up to eight hours, and are revoked on logout. There is no public registration or password-reset flow yet.

During local development, an optional **Fill temporary login** button fills the configured temporary password without submitting. It is enabled through `VITE_TEMPORARY_LOGIN_PASSWORD` in ignored `apps/web/.env.local` and excluded from production builds. Remove that setting when replacing the temporary password. It is intentionally available to anyone using this local development page.

Stop the dev servers with Ctrl-C. Stop PostgreSQL while preserving its data with `npm run db:stop`.

## Other database options

For hosted PostgreSQL, copy `.env.example` to `.env`, set `DATABASE_URL`, and generate separate random values for `SESSION_SECRET` and local development `SETUP_TOKEN`:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Do not run `db:local` with a hosted database URL. Alternatively, set `POSTGRES_PASSWORD` and a matching `DATABASE_URL` and run `docker compose up -d postgres`. Use only one database option on port 5433. Removing the local cluster or Docker volume deletes its saved data.

The API initializes the account/session, prospect, and Discovery tables. Browser password setup works only in development through a loopback connection with the setup token and configured Origin. Production requires an already-created account, HTTPS `APP_ORIGIN`, a strong session secret, and a trusted reverse proxy forwarding HTTPS to the loopback-bound API. Browser setup is disabled and session cookies use Secure in production.

## Verify

```sh
npm run typecheck
npm run build
npm test
```

Integration tests require PostgreSQL and `.env`. They create temporary schemas, use a test-only password, and remove only those schemas; they do not change the live account or prospects. Optionally set `TEST_DATABASE_URL` to a separate database.

Tests cover protected setup, hashing, duplicate setup, wrong credentials, session rotation, persistence across API restarts, logout revocation, expiry, CSRF/origin checks, production cookies, and rate limiting. Prospect tests cover authenticated access, persistence, validation, source evidence, search/filter/pagination, concurrent duplicate creation, and stale edit protection.

## Structure

- `apps/web/src/features`: auth, prospects, discovery, AI, outreach, dashboard.
- `apps/api/src/modules`: corresponding backend modules.
- `apps/api/src/db`: PostgreSQL connection and schema initialization.
- `scripts`: local PostgreSQL lifecycle and setup link.

This is its own npm workspace. Run commands from `ehud-radar/`; dependencies, configuration, and ports are separate from the storyboard app.

## Authentication API

- `GET /api/auth/state`: setup/session state and CSRF token.
- `POST /api/auth/setup`: local first-time password creation.
- `POST /api/auth/login`: shared-account login.
- `POST /api/auth/logout`: session invalidation.
- `GET /api/dashboard`: protected starter endpoint.
- `GET /api/health`: API liveness only.

Auth mutations require the configured Origin and session `X-CSRF-Token`. Password requests are rate limited; account responses use `Cache-Control: no-store`. Add `requireAccount` to every future private API route. Keep secrets in the backend's ignored `.env`, never frontend variables.

## Prospects

After signing in, select **Add prospect**. Name and category are required; website, contact details, location, relevance to Ehud, team notes, and up to 20 source links are optional. Each source requires a complete HTTP or HTTPS URL. Save to open its profile; the profile URL can be bookmarked. Use **Edit prospect** to update it. Search the directory by name, contact, location, relevance, or notes and filter by category. Results are paginated in groups of 25.

PostgreSQL retains prospects across restarts. Duplicate websites and duplicate name/location pairs are rejected. Websites preserve profile paths so different social profiles can be saved separately. An edit version prevents a stale browser tab from overwriting newer changes; failed saves keep the draft, and a stale edit can explicitly reload the saved record.

- `GET /api/prospects?q=&category=&page=1&pageSize=25`: filtered directory and total count.
- `POST /api/prospects`: create a prospect.
- `GET /api/prospects/:id`: saved profile.
- `PUT /api/prospects/:id`: update with the current `version`.

All prospect routes require login. Writes also require the configured Origin and session `X-CSRF-Token`. There is no delete, scheduled discovery, automatic sending, or scheduled reminder yet. Prospect management does not call an AI model.

For isolated browser development, `RADAR_WEB_PORT` and `RADAR_API_TARGET` can override Vite's default port and backend target. These are server-only environment settings.


## Discovery

Select **Discovery** in the workspace. Choose a category, target location, optional keywords, and up to 5 or 10 results. Search history and source excerpts persist in PostgreSQL. Results can include directories or general pages, so review the actual source before treating a candidate as a relevant prospect.

Set these values in the ignored backend `.env`, then restart the API:

```dotenv
SEARCH_PROVIDER=serper
SERPER_API_KEY=your-local-key
OPENROUTER_API_KEY=your-local-key
OPENROUTER_MODEL=openrouter/free
```

Search works without an AI key. Tavily remains an alternative: set `SEARCH_PROVIDER=tavily` and `TAVILY_API_KEY`. Providers are selected explicitly; there is no automatic fallback. Keys stay on the backend.

**Assess fit with AI** is optional and runs only when selected. It sends the public result title, URL, excerpt, and search targets to OpenRouter. Completed assessments are cached; exact source quotes and a source-backed name are required. The router is restricted to free models, with no paid fallback or web-search plugin. Free-model availability and key/account limits can prevent an assessment; manual review and saving remain available.

**Review & save** opens an editable prospect form. Contact details and location start blank for verification. Saving always retains the original search link and excerpt, even if edited sources remove it. Existing website or name/location duplicates are linked without overwriting the saved prospect. Dismissed candidates can be restored. Unsaved edits receive a leave confirmation.

The backend permits 20 search attempts and 20 AI assessment attempts per rolling 24 hours, including failed attempts. A search request ID prevents repeated submission from consuming another provider call; candidate saves are idempotent. Only one search runs at a time. Work left running for more than two minutes expires with a retryable failure.

- `GET /api/discovery/state`: provider availability and remaining daily allowance.
- `GET /api/discovery/runs?page=1`: paginated search history.
- `POST /api/discovery/runs`: run a search with a UUID request ID and search settings.
- `GET /api/discovery/runs/:id`: results and assessment state.
- `POST /api/discovery/candidates/:id/assess`: optional cached fit assessment.
- `POST /api/discovery/candidates/:id/dismiss`: dismiss or restore.
- `POST /api/discovery/candidates/:id/save`: review fields and save/link a prospect.

All Discovery routes require login; mutations also require the configured Origin and session CSRF token. Tests use injected providers and temporary database schemas to cover persistence, quotas, concurrency, duplicates, original evidence, cached assessments, and provider validation without consuming external credits.


## Research and outreach

Open a saved prospect and select **Research & outreach**. Capture a source-backed research summary, contact role and source URL, outreach status, follow-up date, and internal outreach notes. Contact names and details remain editable through **Edit contact details**. **Review evidence** returns to the prospect’s saved sources. Dates are calendar dates, and follow-ups due today or earlier are highlighted locally; no notification scheduler runs.

Write and save an email or LinkedIn message manually, or choose a message goal and select **Generate draft**. Saved drafts are editable and reopenable, and unsaved edits receive a leave confirmation. **Copy message** copies the current editor content; nothing sends automatically. Status changes are manual and do not imply a message was sent.

Optional AI requires an active `OPENROUTER_API_KEY`. The shared transport uses only `openrouter/free`, zero-price provider routing, and strict JSON, with no search plugins, tools, or paid fallback. Draft requests include only the prospect name/category, saved source titles/URLs/excerpts, channel, and message goal. Internal research summaries, contact details, and outreach/team notes are excluded. Generation requires at least one source excerpt; URL-only sources are insufficient.

AI evidence quotes must match the indexed saved source exactly. This proves quote grounding, not every generated claim: your team must verify wording, recipient, fit, and any edited content before sending. Each draft stores the source snapshot, evidence, caveats, model, and provenance. A sources-changed notice prompts review when the current prospect evidence differs.

Completed generations are reused for the same public evidence, channel, and goal, preserving human edits. There are 10 generation attempts per rolling 24 hours, including failures; opening a cached draft consumes no extra provider call. Only one draft generates at a time. Interrupted work expires after two minutes. Failed generations remain in history and preserve all other drafts. Manual drafts work without an AI key. Saved history is paginated in groups of 20.

Research and draft updates carry separate versions so another browser tab cannot overwrite newer edits. Manual draft creation and AI generation carry UUID request IDs to recover from uncertain submissions without repeating work.

- `GET /api/outreach/:id?page=1`: research, draft history, AI availability and allowance for a prospect.
- `PUT /api/outreach/:id`: save research and follow-up state using its version.
- `POST /api/outreach/:id/drafts`: save a manual draft with a request ID.
- `PUT /api/outreach/:id/drafts/:draftId`: save draft edits using its version.
- `POST /api/outreach/:id/generate`: optionally generate/cache a source-grounded draft with the current prospect version.

All routes require login. Writes also require the configured Origin and session CSRF token. Tests use temporary PostgreSQL schemas and injected AI responses to verify auth, persistence, calendar dates, concurrent edits, idempotency, caching, quotas, failure isolation, provenance, and grounding without external model calls.
