# S01-08 model and persistence privacy audit

Result: **PASS** for AC7.

Audit time: 2026-07-24T19:05:03Z

Implementation commits: `20d84f8`, `93e7988`, `27cb821`

Owner-approved boundary: `9d0c516`

## Inspected production boundary

- `server/src/google/calendar.ts`
- `server/src/scheduling/availability.ts`
- Production imports and uses outside those two defining modules
- Package manifests and the three S01-08 implementation commits

The Calendar adapter returns only the scope-approved summary projection:
identifier, bounded title, start, end, time zone, busy/free status, bounded
recurrence, and event status. Provider description, location, attendees,
organizer, and the full response object are discarded.

Google FreeBusy, not event-list metadata, is the authority for blocked
intervals. Event summaries remain separate and do not enter the availability
engine.

## Model boundary

Static inspection found no OpenAI, decision-engine, model-request, or prompt
import or call in either new production module. It also found zero production
consumers of `GoogleCalendarAdapter`, `CalendarEventSummary`,
`eventSummaries`, or `findWorkWindows` outside their defining modules.

The bounded event title therefore has no path into model context in S01-08.
Connecting this deterministic boundary to later conversation flows remains a
later story and must preserve the same restriction.

Live OpenAI calls during QA: **0**.

## Persistence boundary

Static inspection found no repository, Supabase, SQL, commitment,
work-session, scheduled-message, event-ledger, or model-decision import or call
in the new production modules. The implementation persists no Calendar
response, event title, token, work window, or availability result.

Durable integration is intentionally outside S01-08. Later stories may persist
only the ADR-approved checked range, check timestamp, status, and chosen work
window.

Database calls during QA: **0**.

## Logging and credential boundary

The new production modules contain no console or structured-logger call. They
do not log request bodies, event titles, provider payloads, access tokens, or
authorization headers.

The access token comes from the owner-approved injected server-only token
provider. Invalid non-primary or overlong ranges fail before the token provider
or HTTP client is invoked. For valid requests, the token is used only in the
Google Authorization header and is neither returned nor persisted.

Evidence stores `[REDACTED]`, not an Authorization value. No `.env.local`
value was copied into an artifact.

## Calendar mutation and dependency audit

The adapter uses one FreeBusy query and one primary-events read. FreeBusy uses
POST because that Google read endpoint accepts a query body; the events request
uses GET. There is no Calendar create, update, patch, or delete endpoint.

The three S01-08 implementation commits touch exactly four approved source/test
files and make no package-manifest or runtime-dependency change.

Live Google calls during QA: **0**. All HTTP-contract evidence used controlled
fixtures.

## Re-runnable static checks

```text
rg -n "openai|DecisionEngine|model_decisions|commitments|work_sessions|scheduled_messages|commitment_events|supabase|repository|console\\.|logger|\\.log\\(" \
  server/src/google/calendar.ts server/src/scheduling/availability.ts
```

Observed matches: **0**.

```text
rg -n "GoogleCalendarAdapter|CalendarEventSummary|eventSummaries|findWorkWindows" \
  server/src --glob '!**/*.test.ts' \
  --glob '!**/google/calendar.ts' \
  --glob '!**/scheduling/availability.ts'
```

Observed production consumers outside the defining modules: **0**.

## AC7 conclusion

Only bounded, read-only Calendar data enters the adapter. No Calendar event
title, full provider object, access token, or unrestricted Calendar payload
enters a model request, product history, persistence repository, or log in
S01-08.
