# Shiori initial infrastructure spike

A small public application that proves Shiori's browser and API foundations can be developed, tested, packaged, and deployed together. Clicking **Ping** calls the backend and displays **Pong**.

This is an infrastructure precursor to the product in [`PRODUCT.md`](./PRODUCT.md), not an implementation of Shiori's Telegram or commitment behavior. The frozen slice contract is in [`spike.md`](./spike.md).

## Live application

[Open the live application](https://shiori-spike-production.up.railway.app)

Verified public endpoints:

```sh
curl --fail-with-body https://shiori-spike-production.up.railway.app/api/ping
curl --fail-with-body https://shiori-spike-production.up.railway.app/api/health
```

## API contract

| Method | Path | Successful response |
| --- | --- | --- |
| `GET` | `/api/ping` | `200 {"message":"pong"}` |
| `GET` | `/api/health` | `200 {"status":"ok"}` |

Both endpoints are public, anonymous, and stateless.

## Prerequisites

- Node.js 24 LTS. The repository includes an `.nvmrc` for version managers such as `nvm`.
- npm 11 or newer.
- Docker Desktop or another Docker-compatible runtime for the container workflow.
- A Railway account and the [Railway CLI](https://docs.railway.com/guides/cli) for deployment.

## Run locally with Node.js

From a fresh checkout:

```sh
nvm use
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite serves the React application and proxies `/api` requests to Fastify on port `3000`.

Test the development APIs directly:

```sh
curl --fail-with-body http://localhost:3000/api/ping
curl --fail-with-body http://localhost:3000/api/health
```

Stop both development processes with `Ctrl+C`.

## Test and verify

Install the Chromium browser used by Playwright once:

```sh
npx playwright install chromium
```

Run all static checks, API tests, the production build, and browser tests:

```sh
npm run check
```

Individual commands are also available:

```sh
npm run typecheck
npm run test:api
npm run build
npm run test:e2e
```

## Run the production build locally

The production server serves both APIs and the compiled React application from one origin:

```sh
npm ci
npm run build
PORT=3000 npm start
```

Open [http://localhost:3000](http://localhost:3000), then call:

```sh
curl --fail-with-body http://localhost:3000/api/ping
curl --fail-with-body http://localhost:3000/api/health
```

## Run locally with Docker

Build the same container used by Railway:

```sh
docker build --tag shiori-spike:local .
docker run --rm --publish 3000:3000 --env PORT=3000 shiori-spike:local
```

Open [http://localhost:3000](http://localhost:3000), or verify the APIs from another terminal:

```sh
curl --fail-with-body http://localhost:3000/api/ping
curl --fail-with-body http://localhost:3000/api/health
```

Stop the container with `Ctrl+C`.

If Docker Desktop stalls while loading public base-image metadata, a stale client credential helper may be the cause. A one-time empty client configuration can isolate that local issue without changing the repository or global Docker settings:

```sh
SHIORI_DOCKER_CONFIG="$(mktemp -d)"
DOCKER_CONFIG="$SHIORI_DOCKER_CONFIG" docker pull node:24-alpine
DOCKER_CONFIG="$SHIORI_DOCKER_CONFIG" docker build --tag shiori-spike:local .
rmdir "$SHIORI_DOCKER_CONFIG"
```

## Deploy to Railway

The Dockerfile is the deployment boundary. Railway detects it and injects the `PORT` environment variable automatically.

1. Install the Railway CLI and open a terminal in this repository.
2. Build and test the application locally with `npm run check`.
3. Deploy the current directory:

   ```sh
   railway up
   ```

   If this directory is not linked yet, the CLI guides you through authentication and project/service creation.

4. In Railway, generate a public domain for the service if one was not generated during setup.
5. Verify the public deployment, replacing `<railway-domain>` with the assigned hostname:

   ```sh
   curl --fail-with-body https://<railway-domain>/api/ping
   curl --fail-with-body https://<railway-domain>/api/health
   ```

6. Open `https://<railway-domain>/`, click **Ping**, and confirm **Pong** appears.

The page and both APIs must resolve from the same HTTPS origin. No application secrets, database, or custom variables are required.

## Repository structure

```text
server/          Fastify server, API routes, and API contract tests
web/             React/Vite browser application
tests/e2e/       Playwright browser verification
Dockerfile       Shared local and Railway production image
spike.md         Agreed slice scope and definition of done
```
