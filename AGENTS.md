# Shiori repository guidance

## Product references

- `docs/product.md` is the canonical contract for the first product iteration.
- `docs/spike.md` records the completed infrastructure spike.
- Do not introduce runtime mock data for commitments, outcomes, calendar state, history, or dashboard summaries.

## Architecture

- `web/` contains the React and Vite browser application.
- `server/` contains the Fastify API and serves the production web build.
- `tests/e2e/` contains Playwright browser verification.
- The application is packaged by `Dockerfile` and deployed to Railway.

## Product boundaries

- Telegram is the primary interaction and commitment-management surface.
- The dashboard reads live product data and remains read-only.
- Google Calendar access is read-only and limited to the event fields allowed by `docs/product.md`.
- Calendar events never become commitments without explicit user confirmation.
- Advanced memory, behavioural inference, adaptive reminders, and calendar writes are outside the first iteration.

## Development

- Use Node.js 24 and npm 11 or newer.
- Run `npm run check` before handing off implementation changes.
- Keep API and browser behaviour covered in proportion to the change.
- Never commit secrets or local environment values.
