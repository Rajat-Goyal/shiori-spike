# Shiori initial infrastructure spike

Status: agreed scope for the first implementation slice

## Purpose

Build and publicly deploy the smallest useful application slice that validates Shiori's intended web and API foundations.

This spike is infrastructure scaffolding for the product described in [`PRODUCT.md`](./PRODUCT.md). It does not implement Shiori's Telegram, commitment, persistence, or agent behaviour. Its purpose is to prove that a browser application and backend APIs can be developed locally, packaged together, tested, deployed, and reached over the public internet.

## User outcome

A user can open the public application, click a **Ping** button, and see **Pong** after the application receives a successful response from the ping API.

The same public deployment exposes a health API that can be used to confirm the service is running.

## Technical approach

- Use TypeScript throughout.
- Use React with Vite for the browser application.
- Use Fastify for the HTTP server and APIs.
- Keep the browser application and server in clearly separated modules within one repository.
- Build and serve the React application from the Fastify service in production.
- Deploy the application as one stateless service and one public origin.
- Provide a Dockerfile that is usable both locally and by Railway.
- Use an environment-provided `PORT`; no secrets or database configuration are required.

This structure should allow the web surface and backend to evolve independently later without introducing multiple deployments, cross-origin configuration, or additional infrastructure in this slice.

## API contract

### Ping

`GET /api/ping`

Successful response:

- HTTP status: `200 OK`
- Content type: `application/json`
- Body: `{"message":"pong"}`

### Health

`GET /api/health`

Successful response:

- HTTP status: `200 OK`
- Content type: `application/json`
- Body: `{"status":"ok"}`

The endpoints are anonymously accessible and do not mutate state.

## Browser experience

Create a clean, responsive single-screen application containing:

- A page title and a short explanation.
- A **Ping** button.
- A result area that shows **Pong** after a successful `/api/ping` response.
- A visible loading state while the request is in progress.
- A visible, understandable error state if the request fails.

The button must call the deployed application's API rather than simulate the response in browser code. Broader Shiori branding, dashboard navigation, and additional screens are not required.

## Public deployment

Deploy the service to Railway using the repository's Dockerfile.

- Railway provides a public HTTPS domain.
- The page, `/api/ping`, and `/api/health` are available from the same origin.
- No authentication is required for this spike.
- The final public base URL is recorded in the README.
- Completion requires smoke-checking the page and both endpoints over the public Railway URL.

The Dockerfile remains the portable deployment boundary; provider-specific application code should not be required.

## Local development and documentation

Create a `README.md` that explains:

- The prerequisites, including the supported Node.js version and Docker.
- How to install dependencies.
- How to run the web application and server in local development.
- How to run automated tests.
- How to create a production build and run it locally.
- How to build and run the application locally with Docker.
- How to call both APIs locally, with example commands.
- How to deploy the Dockerized application to Railway.
- How to call both APIs on the deployed service.
- The verified public application URL.

The documented commands should be runnable from a fresh checkout without relying on unpublished local configuration.

## Verification

Automated verification must include:

- An API test proving `/api/ping` returns status `200` and the agreed JSON body.
- An API test proving `/api/health` returns status `200` and the agreed JSON body.
- A browser-level test that loads the page, clicks **Ping**, and observes **Pong**.

Deployment verification must confirm over HTTPS that:

1. The public page loads.
2. Clicking **Ping** produces **Pong**.
3. `/api/ping` returns the agreed response.
4. `/api/health` returns the agreed response.

## Deliverables

- React/Vite browser application.
- Fastify API server.
- Production build configuration that serves both from one process.
- Dockerfile.
- Automated API and browser-level tests.
- README with local and Railway instructions plus the verified public URL.
- Live Railway deployment.

## Definition of done

The spike is complete when:

- The browser behavior and both APIs match their contracts.
- The application works at phone and desktop widths.
- Loading and request-failure states are visible and understandable.
- All automated tests pass from a fresh local checkout.
- Both documented local workflows—native Node.js and Docker—work.
- The page and APIs are anonymously accessible on one public Railway HTTPS origin.
- The deployed page and APIs pass the live smoke verification.
- The README contains accurate commands and the verified public URL.

## Out of scope

- Telegram integration or owner binding.
- Commitment classification or agent/model behavior.
- Supabase or any other database.
- Authentication, authorization, onboarding, or multiple users.
- Persistence or other stateful API behavior.
- Queues, scheduled work, reminders, or background workers.
- The weekly Shiori dashboard.
- Product analytics, production monitoring, or alerting.
- Additional ping/pong modes, history, or real-time behavior.

## Follow-on intent

This spike establishes reusable browser, API, testing, container, and deployment foundations. A later slice may extend those foundations toward the behavior in `PRODUCT.md`, but any such work requires its own agreed scope and acceptance criteria.
