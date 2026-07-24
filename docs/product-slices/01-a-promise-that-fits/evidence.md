# Evidence — product slice 1, A Promise That Fits

Status: not yet verified

Scope: [`scope.md`](./scope.md)

Architecture: [`adr.md`](./adr.md)

## Purpose

This file is the slice-specific record that the implemented and deployed product matches the accepted scope. Populate it with real deployed evidence; do not use runtime mock data as product evidence.

Do not record secrets, OAuth codes, access or refresh tokens, cookies, authorization headers, complete Calendar responses, unrelated Calendar events, or unrelated personal conversations.

## Verification environment

| Field | Evidence |
|---|---|
| Verification date | Pending |
| Verifier | Pending |
| Git commit | Pending |
| Railway deployment | Pending |
| Public application URL | Pending |
| Health endpoint result | Pending |
| Configured owner time zone | `Asia/Singapore` |
| OpenAI model identifier | Pending |
| Prompt version | Pending |
| Database migration version | Pending |
| Google OAuth status | Testing |

## Automated verification

| Check | Command or artifact | Result |
|---|---|---|
| Type checking | `npm run typecheck` | Pending |
| API and unit tests | `npm run test:api` | Pending |
| Production build | `npm run build` | Pending |
| Browser verification | `npm run test:e2e` | Pending |
| Full repository check | `npm run check` | Pending |

## Evidence record format

For each scenario, capture:

1. Redacted user input or button action.
2. Validated structured decision, when a model decision is involved.
3. Deterministic application action.
4. Relevant stored state and unique identifiers.
5. Telegram response or scheduled-delivery result.
6. Dashboard evidence.
7. Pass/fail result and notes.

Screenshots should be referenced with repository-relative paths if later added to an evidence-assets directory. Redact unrelated Calendar titles and personal data.

## Scenario matrix

| ID | Scenario | Required result | Status |
|---|---|---|---|
| S1 | Dashboard owner login | Owner admitted; unauthenticated request refused | Pending |
| S2 | Google Connect | Personal account connects from dashboard; no token exposed | Pending |
| S3 | Explicit request before confirmation | Draft only; no commitment or schedule | Pending |
| S4 | Implied intention | Permission requested; no save before agreement | Pending |
| S5 | Ordinary question | Helpful answer; no product-state mutation | Pending |
| S6 | Simple action | One confirmed commitment and one reminder | Pending |
| S7 | Free work-session proposal | Correct slot and final free recheck | Pending |
| S8 | Busy proposal | Conflict explained and up to two valid alternatives | Pending |
| S9 | Newly introduced conflict | Final recheck blocks stale confirmation | Pending |
| S10 | Calendar unavailable | Explicit Save without Calendar check remains possible | Pending |
| S11 | Work-session start | Exactly one start reminder | Pending |
| S12 | Work-session end | Exactly one end check-in | Pending |
| S13 | Done | Commitment closes once and dashboard updates | Pending |
| S14 | Need more time | Partial session result and one newly confirmed next session | Pending |
| S15 | Missed this session | Missed result and optional next-session flow | Pending |
| S16 | Recovery session | Target unchanged; commitment remains overdue | Pending |
| S17 | Non-response | No additional notification | Pending |
| S18 | Cancellation | Confirmation required; unsent messages cancelled | Pending |
| S19 | Restart durability | Scheduled messages survive service restart | Pending |
| S20 | Webhook replay | No duplicate draft, commitment, session, or event | Pending |
| S21 | Callback replay or stale button | No repeated transition; stale action rejected safely | Pending |
| S22 | Telegram owner boundary | Unauthorized user and non-private chat refused | Pending |
| S23 | Dashboard owner boundary | Protected APIs reveal no owner state without session | Pending |
| S24 | Calendar access boundary | Primary Calendar, read-only scopes, allowed fields only | Pending |
| S25 | Model privacy boundary | Calendar event details absent from model request | Pending |
| S26 | Persistence privacy boundary | No full Calendar objects, titles, transcripts, or webhook dumps retained | Pending |
| S27 | Delivery ambiguity | Unknown result not retried into a possible duplicate | Pending |
| S28 | Dashboard parity | Live dashboard matches Telegram and ledger state | Pending |

## Detailed evidence

### S1 — Dashboard owner login

- Input/action: Pending
- Stored or observed state: Pending
- Dashboard/API evidence: Pending
- Result: Pending

### S2 — Google Connect

- Input/action: Pending
- OAuth scopes observed: Pending
- Connected identity evidence: Pending
- Token-exposure check: Pending
- Dashboard evidence: Pending
- Result: Pending

### S3 — Explicit request before confirmation

- Redacted input: Pending
- Structured decision: Pending
- Draft state: Pending
- Commitment query: Pending
- Telegram response: Pending
- Dashboard evidence: Pending
- Result: Pending

### S4 — Implied intention

- Redacted input: Pending
- Structured decision: Pending
- Permission response: Pending
- No-save evidence: Pending
- Result: Pending

### S5 — Ordinary question

- Redacted input: Pending
- Structured decision: Pending
- Telegram answer: Pending
- No-mutation evidence: Pending
- Result: Pending

### S6 — Simple action

- Redacted input: Pending
- Structured decision: Pending
- Confirmation callback: Pending
- Commitment state: Pending
- Scheduled-message state: Pending
- Telegram reminder evidence: Pending
- Result: Pending

### S7 — Free work-session proposal

- Redacted input: Pending
- Requested duration: Pending
- Calendar query window: Pending
- Candidate calculation: Pending
- Final recheck: Pending
- Stored session: Pending
- Result: Pending

### S8 — Busy proposal

- Redacted input: Pending
- Proposed interval: Pending
- Sanitized conflict evidence: Pending
- Alternative 1: Pending
- Alternative 2: Pending
- Validation against Calendar: Pending
- Result: Pending

### S9 — Newly introduced conflict

- Initial free check: Pending
- Calendar change: Pending
- Final recheck: Pending
- Prevented-save evidence: Pending
- New choice response: Pending
- Result: Pending

### S10 — Calendar unavailable

- Failure condition: Pending
- Telegram response: Pending
- Save-without-check confirmation: Pending
- Stored unverified state: Pending
- Result: Pending

### S11 — Work-session start

- Session identity: Pending
- Scheduled logical key: Pending
- Delivery event: Pending
- Telegram message evidence: Pending
- Duplicate check: Pending
- Result: Pending

### S12 — Work-session end

- Session identity: Pending
- Scheduled logical key: Pending
- Delivery event: Pending
- Telegram button evidence: Pending
- Duplicate check: Pending
- Result: Pending

### S13 — Done

- Callback action: Pending
- Commitment transition: Pending
- Ledger event: Pending
- Cancelled pending messages: Pending
- Dashboard evidence: Pending
- Replay result: Pending
- Result: Pending

### S14 — Need more time

- Callback action: Pending
- Session transition: Pending
- Remaining-duration input: Pending
- New Calendar options: Pending
- New confirmation: Pending
- One-next-session constraint: Pending
- Dashboard evidence: Pending
- Result: Pending

### S15 — Missed this session

- Callback action: Pending
- Session transition: Pending
- Reschedule choice: Pending
- Duration confirmation: Pending
- New session or declined state: Pending
- Result: Pending

### S16 — Recovery session

- Original target: Pending
- Overdue state: Pending
- Recovery search window: Pending
- Confirmed recovery session: Pending
- Unchanged-target evidence: Pending
- Result: Pending

### S17 — Non-response

- Check-in delivery time: Pending
- Observation window: Pending
- Scheduled-message query: Pending
- No-additional-delivery evidence: Pending
- Outstanding state: Pending
- Result: Pending

### S18 — Cancellation

- Initial Cancel action: Pending
- Confirmation requirement: Pending
- Commitment transition: Pending
- Cancelled scheduled messages: Pending
- Calendar no-write evidence: Pending
- Dashboard evidence: Pending
- Result: Pending

### S19 — Restart durability

- Scheduled item before restart: Pending
- Restart/deployment evidence: Pending
- Scheduled item after restart: Pending
- Delivery evidence: Pending
- Duplicate check: Pending
- Result: Pending

### S20 — Webhook replay

- Telegram update ID: Pending
- Replay method: Pending
- Processing results: Pending
- State counts before/after: Pending
- Result: Pending

### S21 — Callback replay or stale button

- Entity and version: Pending
- Initial action result: Pending
- Replay/stale action: Pending
- Ledger and state counts: Pending
- User-facing response: Pending
- Result: Pending

### S22 — Telegram owner boundary

- Unauthorized user attempt: Pending
- Group/channel attempt: Pending
- Generic refusal: Pending
- No-data-exposure evidence: Pending
- Result: Pending

### S23 — Dashboard owner boundary

- Unauthenticated requests: Pending
- Invalid session request: Pending
- Authenticated owner request: Pending
- Rate-limit evidence: Pending
- Result: Pending

### S24 — Calendar access boundary

- Granted scopes: Pending
- Queried Calendar ID: Pending
- Requested fields: Pending
- Write-permission absence: Pending
- Multi-Calendar absence: Pending
- Result: Pending

### S25 — Model privacy boundary

- Redacted provider request capture: Pending
- Calendar fields absent: Pending
- Deterministic availability result supplied: Pending
- Result: Pending

### S26 — Persistence privacy boundary

- Tables inspected: Pending
- Full webhook absence: Pending
- Transcript absence: Pending
- Calendar title/object absence: Pending
- Token plaintext absence: Pending
- Result: Pending

### S27 — Delivery ambiguity

- Injected or observed ambiguity: Pending
- Delivery state: Pending
- Retry behavior: Pending
- Logical event count: Pending
- Result: Pending

### S28 — Dashboard parity

- Commitment identity: Pending
- Telegram state: Pending
- Database state: Pending
- Dashboard state: Pending
- Refresh timestamp: Pending
- Result: Pending

## Known limitations observed during verification

- Google OAuth is intentionally kept in Testing and requires periodic Reconnect: Pending confirmation
- Other limitations: Pending

## Final assessment

- All required scenarios passed: Pending
- Any accepted deviations: Pending
- Slice status: Not yet shipped
- Sign-off: Pending
