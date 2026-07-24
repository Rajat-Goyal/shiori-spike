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

The local database must be running and migrated for `npm run test:db`. Browser
tests use controlled HTTP responses for explicit UI states and never introduce
runtime fallback data into the application.

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
