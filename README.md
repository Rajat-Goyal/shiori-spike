# Shiori

Shiori is a private, single-owner promise assistant. Telegram is its primary
interaction surface; the browser is a protected, read-only view of live product
state.

This repository contains one Fastify service, a React/Vite browser application,
and a Supabase/Postgres migration. Fastify is the only application boundary:
the browser never receives Supabase credentials and never reads the database
directly.

## Current walking skeleton

The current slice provides:

- a public login shell and health endpoint;
- Argon2id owner-password verification with rate-limited failures;
- a short-lived signed `HttpOnly`, `Secure`, `SameSite=Lax` session cookie;
- owner-protected session, logout, and dashboard-summary APIs;
- a factual empty dashboard summary read from local Supabase; and
- responsive login, loading, empty, error, refresh, and session-expiry states.

There is no runtime sample commitment data. The dashboard does not create or
change commitments.

## Prerequisites

- Node.js 24 and npm 11 or newer
- Docker Desktop or another Docker-compatible runtime
- the Supabase CLI for the local database workflow
- Chromium installed for Playwright (`npx playwright install chromium`)

## Configure and run locally

Copy the value-free environment template and fill the server-side values:

```sh
cp .env.example .env.local
```

The template documents how to generate the Argon2id password hash and session
secret. Never put a plaintext dashboard password in an environment file.

Start the Docker-local Supabase project, apply the migration, and copy only its
generated API URL and `service_role` credential into the ignored `.env.local`:

```sh
supabase start
supabase db reset
supabase status
```

Do not use a hosted database for `npm run test:db`; that command intentionally
accepts only the local API on port `54321`.

Install dependencies and run both development servers:

```sh
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to
Fastify on port `3000`.

## API boundary

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/health` | Public |
| `GET` | `/api/ping` | Public infrastructure compatibility |
| `POST` | `/api/owner/login` | Public, rate-limited |
| `GET` | `/api/owner/session` | Owner session |
| `POST` | `/api/owner/logout` | Owner session |
| `GET` | `/api/dashboard/summary` | Owner session |

Owner responses use `Cache-Control: no-store`. Fastify returns the summary
timestamp with its live Supabase read.

## Verify

Run focused boundaries:

```sh
npm run test --workspace @shiori/server -- src/app.test.ts
npm run test:db
npm run test:e2e -- tests/e2e/owner-dashboard.spec.ts
```

Run the complete typecheck, API-test, production-build, and browser-test gate:

```sh
npm run check
```

### Verify one immutable release

The release verifier is fail-closed and value-redacting. It pins the clean Git
source/archive, exact migration manifest and hosted ledger, Node/npm versions,
the dedicated Railway service and one replica, terminal deployment/image,
public domain and health schema. It permanently refuses the legacy Railway
service.

Use the read-only mode while preparing a release:

```sh
npm run verify:release -- --env-file=.env.local --phase=deploy --execution-mode=verify
```

The release squad uses production mode only after approving hosted migrations
and deployment. Production mode is the default for the canonical command:

```sh
npm run verify:release -- --env-file=.env.local --phase=deploy
```

That command runs the clean install, disposable migration/database gate and
full repository check before applying only the exact pending migration suffix
and deploying the recorded HEAD to:

- project `d8806797-6bb9-495b-8e10-b13122a6eff6`;
- environment `0a533591-3fce-4904-8fb3-84d0f52346e7`;
- service `85bc7677-b070-43ce-8ae1-e2c65241a721`; and
- `https://shiori-slice-01-production.up.railway.app`.

It creates the release manifest and rollback baseline once with integrity
digests and refuses to overwrite either. The release/QA squads then provide
bounded, redacted scenario artifacts and run:

```sh
npm run verify:release -- --env-file=.env.local --phase=journeys --release-manifest=evidence/S01-12/release-manifest.json
npm run verify:release -- --env-file=.env.local --phase=boundaries --release-manifest=evidence/S01-12/release-manifest.json
npm run verify:release -- --env-file=.env.local --phase=assess --release-manifest=evidence/S01-12/release-manifest.json
```

Scenario artifacts contain the exact ordered S1–S18 or S19–S28 index. Each
scenario records only `id`, `status`, `executionMode`, and bounded checks with
optional SHA-256 evidence hashes. Raw HTTP bodies, owner identity, message
text, OAuth/webhook material, Calendar details, tokens, cookies, secrets and
conversation data are rejected.

The local database must be running and migrated for `npm run test:db`. Browser
state tests use controlled HTTP responses for explicit failure conditions and
never introduce runtime fallback data into the application. `npm run check`
keeps those isolated tests repeatable; the focused `owner-dashboard.spec.ts`
command above is the real browser → Fastify → local Supabase acceptance path.

## Production build

Fastify serves the compiled browser and APIs from one origin:

```sh
npm run build
PORT=3000 npm start
```

The `Dockerfile` builds the same one-service artifact used by Railway.
Environment files are excluded from the container build context; `.env.example`
remains included as documentation.

## Repository structure

```text
server/                 Fastify application, auth, persistence adapter, API tests
web/                    React/Vite owner dashboard
supabase/               Local project config and ordered SQL migrations
tests/e2e/              Desktop and mobile Playwright verification
docs/                   Canonical product and slice contracts
Dockerfile              One-service production image
```
