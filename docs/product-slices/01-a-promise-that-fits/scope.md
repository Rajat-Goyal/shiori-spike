# Product slice 1 — A Promise That Fits

Status: shaped and accepted

Parent contract: [`../../product.md`](../../product.md)

Architecture decision record: [`adr.md`](./adr.md)

Verification record: [`evidence.md`](./evidence.md)

## Purpose

This is the first product slice derived from Shiori's overall product contract. It follows Shape Up principles by defining a meaningful end-to-end user outcome, setting a firm boundary around the solution, identifying rabbit holes before implementation, and keeping scope variable inside a fixed bet.

The infrastructure spike proved that the React application and Fastify API can be packaged, deployed to Railway, and reached publicly. This slice uses that foundation to ship the first real Shiori experience.

## Problem

People make promises to themselves without reserving realistic time to act on them. A reminder alone can arrive too late or during an existing obligation. A calendar alone can show availability but does not represent the promised outcome or ask what actually happened.

Shiori should turn an intention into a clear one-off commitment, help the owner choose realistic working time around existing Calendar constraints, remind them when that time arrives, and continue the loop only when the owner explicitly says more work is needed.

## Appetite

This is a bounded product bet. Capacity is fixed and scope is variable.

If the complete shaped experience cannot ship within the available capacity, scope is reduced in the following order:

1. Reduce dashboard polish and the depth of visible history.
2. Reduce ordinary-question answer sophistication to a safe, concise response.
3. Simplify alternative-window ranking while preserving valid free-window calculation.

The following loop is not cuttable:

> Understand the intention → confirm a clear commitment → check Calendar availability → schedule one realistic next action → remind and check in durably → record the outcome → show the same live state on the dashboard.

Work that does not ship within the bet is reshaped rather than automatically extended.

## Product outcome

For one configured owner, Shiori can:

- Distinguish an ordinary question, an implied intention, and an explicit commitment request.
- Turn a confirmed intention into a one-off commitment with an explicit definition of done and target.
- Decide when it is useful to offer help finding work time.
- Read the owner's primary Google Calendar without changing it.
- Warn about a conflict and offer up to two available alternatives.
- Schedule one next work session at a time.
- Send a start reminder and, for duration-based work sessions, an end check-in.
- Record Done, Need more time, Missed this session, and cancellation events.
- Help schedule another work session only after the owner explicitly requests one.
- Show the same live commitment, work-session, reminder, and outcome state on a protected read-only dashboard.

## Shape Up fit

### Rough

This scope defines the interaction affordances, state transitions, policies, and safety boundaries without prescribing visual styling or low-level implementation tasks.

### Solved

The main flows, product rules, architecture boundaries, failure behavior, and consequential confirmations have been decided before implementation.

### Bounded

The slice supports one owner, one Google account, one primary Calendar, one-off commitments, and at most one next planned work session per commitment. The no-gos and cut order prevent adjacent product ideas from expanding the bet.

## Core concepts

### Commitment

A commitment is the promised outcome. Every commitment has:

- One explicit definition of done.
- One target date and time.
- One owner.
- One current lifecycle state.

The target is never silently moved. A commitment may be completed late; it remains overdue until it is done or cancelled.

### Simple action

A simple action is performed at a specific time and does not need a duration-based work session.

Example:

> Call Mum at 7 PM.

Shiori sends one reminder at the target with Done and Cancel actions. Non-response causes no follow-up message.

### Work session

A work session is one scheduled attempt that supports completing a commitment. It does not replace the commitment or its target.

A work session has:

- A start time.
- An end time.
- A duration of 30, 60, 90, or 120 minutes.
- A Calendar-check result.
- A reminder and check-in state.
- An optional session result.

A commitment may accumulate past work sessions, but only one next work session may be planned at a time.

### Recovery session

When no fitting window remains before the target, Shiori may offer a recovery session after the target. The original target remains unchanged and the commitment remains overdue.

## User and access boundary

- One configured Telegram owner.
- Telegram private chat only.
- Telegram text plus Shiori-provided inline action buttons.
- No voice, images, files, group chats, or channels.
- One owner-protected dashboard.
- No onboarding or multi-user account system.
- One personal Google account.
- The connected account's primary Calendar only.
- One configured owner time zone: `Asia/Singapore`.

## Main user journeys

### Explicit one-off commitment with work time

1. The owner sends an explicit commitment request.
2. Shiori extracts the definition of done and target and asks one concise question for each missing field.
3. For every newly complete promise, Shiori asks whether preparation time is needed.
4. If the owner agrees, Shiori asks for a supported duration.
5. Shiori checks primary-Calendar availability.
6. If the proposed time conflicts, Shiori explains the conflict and offers up to two valid alternatives.
7. Shiori presents the complete draft and states that it will not change Google Calendar.
8. The owner corrects the draft, cancels it, or presses Confirm.
9. On Confirm, Shiori rechecks availability.
10. If the result is still acceptable, Shiori creates exactly one commitment and one next work session.
11. Shiori sends a start reminder at the session start.
12. Shiori sends an end check-in at the session end unless the commitment was already completed or cancelled.
13. The owner presses Done, Need more time, or Missed this session.
14. If more work is requested, Shiori helps schedule and confirm one next work session.

### Simple action

1. The owner supplies a definition of done and target that represent one action time.
2. Shiori does not offer a work session when the supplied time is already the intended action time.
3. The owner confirms the draft.
4. Shiori sends one reminder at the target with Done and Cancel.
5. Done closes the commitment. Non-response leaves it outstanding without another message.

### Implied intention

1. Shiori recognizes an implied intention.
2. It asks whether the owner wants help managing it.
3. Nothing is saved before the owner agrees.
4. Agreement enters the same one-off commitment flow.

### Ordinary question

1. Shiori recognizes an ordinary question.
2. It answers without creating or changing a draft, commitment, work session, reminder, or Calendar connection.

### Missed or incomplete work session

At the end check-in:

- Done means the commitment's definition of done has been achieved and closes the commitment.
- Need more time records partial progress without inventing a percentage and asks for the owner's remaining-duration estimate.
- Missed this session records that no work occurred and asks whether the owner wants another window.
- Further work is never scheduled without another explicit confirmation.
- Non-response produces no additional notification.

### Cancellation

- A draft can be cancelled directly.
- `/status` exposes Cancel for an active commitment.
- Saved-commitment cancellation requires a second confirmation.
- Cancellation prevents unsent reminders and check-ins.
- Prior ledger events remain append-only.
- Google Calendar is never changed.

## Input and decision contract

The bounded conversational agent may select only these allowlisted capabilities:

- Read the authoritative active structured draft and the recent bounded conversation turns.
- Propose strict structured output containing:

  - Input class: `explicit_commitment`, `implied_intention`, or `ordinary_question`.
  - Extracted definition of done.
  - Extracted target and time-zone interpretation.
  - Extracted duration and timing constraints.
  - Missing fields.
  - The next conversational action.
  - A user-facing response or response ingredients.

- Request sanitized availability containing only free/busy scheduling results and never Calendar titles or full events.
- Request commitment execution through a paused tool call that the owner must explicitly approve.

The agent loop is capped and has no arbitrary tools. The model does not authenticate the owner, interpret button authority, write the database, schedule messages, or execute a consequential transition by itself. Application code validates every proposal, callback, draft version, and approval before performing an atomic transition. Approval resumes the same bounded paused run; it is not treated as a new uncorrelated owner turn.

Every newly complete promise reaches an application-owned question asking whether preparation time is needed. Yes enters the existing duration and work-window flow. No reaches the normal confirmation flow. The model does not decide whether to omit this question.

## Draft rules

- Only one active draft is allowed.
- Drafts survive service restarts.
- A draft expires after 24 hours of inactivity.
- A new commitment request never overwrites an active draft.
- Corrections increment the draft version.
- Calendar suggestions and inline buttons are bound to a draft ID and version.
- Old buttons become stale when the draft changes, expires, is confirmed, or is cancelled.
- No durable commitment or reminder is created before Confirm.

## Confirmation contract

Before saving, Shiori shows:

- Definition of done.
- Target.
- Simple-action reminder time or work-session start and end.
- Expected duration when applicable.
- Calendar availability result and check time.
- Any conflict and the owner's decision to keep it.
- A clear statement that Google Calendar will not be changed.

The message provides Confirm and Cancel inline buttons. Text corrections are accepted before confirmation and cause the full summary to be shown again.

On Confirm:

- Shiori rechecks Calendar availability for work sessions.
- A newly detected conflict prevents immediate saving and produces new choices.
- The owner may choose another window or explicitly keep the conflicting time.
- Calendar failure offers Save without Calendar check.
- An unverified save records that Calendar availability was not confirmed.

## Calendar policy

### Access

- Google Calendar is read-only.
- OAuth connects one personal Google account from the protected dashboard.
- OAuth remains in Google's Testing status.
- Seven-day refresh-token expiry and periodic Reconnect are accepted slice limitations.
- Connect and Reconnect are included; Disconnect/revocation is not.
- The OAuth identity must match the configured owner email.
- The refresh token is encrypted before storage.
- The encryption key remains in Railway secrets.

### Allowed Calendar fields

- Event identifier.
- Title.
- Start and end.
- Time zone.
- Busy/free status.
- Recurrence information.
- Event status.

Calendar event titles and full event objects are not sent to the language model or stored in commitment history.

### Availability rules

- Primary Calendar only.
- Owner time zone: `Asia/Singapore`.
- Default suggestion hours: 08:00 through 20:00.
- All days of the week are eligible.
- Explicit owner constraints override default hours.
- Search between now and the target, capped at 14 days.
- Recovery search after an overdue target is capped at seven days.
- Suggested start times use 30-minute boundaries.
- Work-session durations are 30, 60, 90, or 120 minutes.
- Sessions do not cross midnight.
- Busy intervals from Google FreeBusy block a candidate.
- Free/transparent and cancelled events do not block a candidate.
- Busy all-day events block that day's suggestion window.
- No automatic buffers are added.
- The owner may keep a conflicting time after an explicit warning.
- If no valid slot exists, Shiori says so rather than silently relaxing constraints.

### Alternative ranking

- When a proposed time conflicts, search the same day first.
- Prefer the nearest later fitting slot, then the nearest earlier fitting slot.
- If the same day has no fit, search forward chronologically.
- When no time was proposed, offer the earliest two fitting windows.
- Alternatives are described as available options, not objectively optimal choices.

### After confirmation

Shiori does not monitor Calendar changes after the commitment is saved. The dashboard says "Free when checked at …" rather than implying current availability.

## Telegram behavior

### Owner boundary

- Validate Telegram's webhook secret header.
- Accept messages and callbacks only from one configured numeric Telegram user ID.
- Accept only the owner's private chat.
- Store the private chat ID for scheduled delivery.
- Return a generic refusal to unauthorized users without exposing owner data.

### Inline actions

Draft:

- Confirm
- Cancel

Simple reminder:

- Done
- Cancel

Work-session start:

- Done

Work-session end:

- Done
- Need more time
- Missed this session

`/status`:

- Done
- Cancel

Callback data contains only an opaque reference, version, and action. It contains no commitment text, Calendar data, or secrets.

### Idempotency

- Repeated Telegram updates do not repeat a state transition.
- Repeated or stale callbacks return the already-resolved state or a stale-action message.
- Done and cancellation can each be recorded only once.
- A start reminder and end check-in can each be scheduled and claimed only once per work session.

## Reminder and check-in rules

- Simple actions receive one reminder.
- Duration-based work sessions receive one start reminder and one end check-in.
- Completing or cancelling the commitment prevents unsent scheduled messages.
- No response produces no additional message.
- Late Done records the actual completion time.
- Reminder delivery uncertainty is represented honestly.
- In an ambiguous Telegram send failure, Shiori does not automatically retry and risk a duplicate.
- Safe, definitive failures may use bounded retries.

## `/status`

`/status` lists active commitments ordered by target and includes:

- Definition of done.
- Target.
- Overdue state.
- Next work session or simple reminder time.
- Calendar-check status.
- Done and Cancel inline actions.

Saved commitments are not editable. The owner must cancel and recreate an incorrect commitment.

## Dashboard

The dashboard is a protected, read-only product view. Its only mutation is managing the read-only Google connection.

It contains:

- Google connection state: disconnected, connected, authorization expired, or temporarily unavailable.
- Connect or Reconnect action.
- Connected owner email and last successful Calendar check.
- Active, due-today, and overdue counts.
- Active commitment cards.
- Definition of done and target.
- Next work session or simple reminder.
- Expected duration.
- "Free when checked at …", conflict-kept, or unverified Calendar status.
- Reminder and check-in delivery status.
- Past work-session results.
- Recent completed and cancelled commitments.
- A short event history.
- Last-updated time and manual refresh.
- Populated, empty, loading, and error states.
- Responsive phone and desktop layouts.

The dashboard does not create, edit, complete, cancel, or reschedule commitments.

## Platform requirements

- Fastify remains the only application backend.
- The browser and Telegram never access Supabase directly.
- Supabase/Postgres is the durable source of truth.
- Pending scheduled messages are claimed transactionally from Postgres.
- The scheduler runs inside the existing Railway service.
- One Railway application replica is used for this slice.
- Database uniqueness and transactional state transitions provide duplicate protection.
- No Redis, external queue, Railway cron job, or Supabase Edge Function is introduced.
- Railway secrets contain application credentials and cryptographic keys.
- Calendar refresh tokens are encrypted with authenticated encryption before persistence.
- Health and public routing from the completed infrastructure spike remain operational.

## Data retention

Persist:

- Telegram update IDs and processing status.
- Structured draft state.
- Validated model decision, configured model identifier, prompt version, and timestamp.
- Up to six application-encrypted recent owner/assistant turns for the active draft session, with a non-sliding 24-hour hard expiry.
- Application-encrypted paused approval state bound to the exact session, owner chat, draft version, and allowlisted tool until it is resolved or expires.
- Commitments and work sessions.
- Scheduled-message state.
- Append-only commitment and work-session events.
- Minimal Calendar-check metadata.
- Encrypted Google refresh token and connection metadata.

Do not persist:

- Complete Telegram webhook payloads.
- Permanent Telegram conversation transcripts.
- Provider-managed conversation state.
- Model chain-of-thought.
- Decrypted paused-run state or unbounded tool-call/tool-output history.
- Full Calendar responses.
- Calendar event titles in commitment history.
- Unredacted secrets or OAuth tokens.

## No-gos

- Google Calendar writes.
- More than one Google account or Calendar.
- Recurring commitments.
- Editing a saved commitment.
- Multiple simultaneous drafts.
- Planning several future work sessions in advance.
- Named Calendar-event matching or linking.
- Snooze and Skip.
- Automatic target changes.
- Automatic recovery scheduling.
- Periodic Calendar-conflict monitoring.
- Adaptive reminders or behavioral inference.
- Persistent nagging after non-response.
- Voice, images, files, group chats, or channels.
- Multi-user onboarding or account management.
- Dashboard commitment mutations.
- Full Calendar agenda.
- Weekly analytics, coaching, patterns, or experiments.
- Formal evaluation platforms or prompt-management systems.
- Google OAuth verification or production publishing status.
- Redis, an external queue, another runtime service, or Calendar-write permissions.
- Runtime mock data for commitments, sessions, reminders, Calendar state, outcomes, history, or dashboard summaries.
- Arbitrary or open-ended model-selected tools.
- Permanent transcripts or agent memory beyond the active encrypted six-turn, 24-hour session.

## Rabbit holes and patches

### Model output is structurally valid but wrong

Patch: use strict allowlisted tool schemas, validate semantic invariants in application code, require explicit confirmation through a resumable paused run, and keep consequential actions deterministic.

### Calendar data leaks into model or storage

Patch: calculate availability in application code, expose only sanitized free/busy scheduling results to the agent, and persist only minimal check metadata.

### A Calendar suggestion becomes stale

Patch: bind suggestions to draft versions and recheck at final confirmation. Do not claim availability remains current after saving.

### Google refresh token expires weekly

Patch: show a distinct expired-authorization state and a dashboard Reconnect action. Calendar failure does not block the core commitment loop.

### Duplicate Telegram updates or button taps

Patch: store update IDs, version callbacks, enforce unique state-transition keys, and return resolved state for repeats.

### Exactly-once Telegram delivery is impossible

Patch: claim before sending, store delivery state, retry only known-safe failures, and prefer an honest `unknown` state over a possible duplicate send.

### Deployment restarts lose timers

Patch: store all schedules in Postgres and claim due work transactionally.

### Work-session continuation becomes an unbounded plan

Patch: schedule only one next work session after an explicit session result and confirmation.

### Dashboard becomes a second management surface

Patch: keep commitments read-only in the dashboard; only Google connection configuration may mutate state.

## Acceptance criteria

The slice is complete only when deployed verification proves:

1. Owner dashboard login succeeds and unauthenticated access is refused.
2. The owner connects a personal Google account from the dashboard.
3. An explicit request creates no commitment before confirmation.
4. An implied intention asks permission and saves nothing before agreement.
5. An ordinary question creates no draft or commitment.
6. A simple action is confirmed, reminded once, and completed with Done.
7. A free work-session proposal is confirmed correctly.
8. A busy proposal produces up to two valid alternatives.
9. A final availability recheck catches a newly introduced conflict.
10. Calendar failure offers an explicitly unverified save.
11. A confirmed duration-based commitment produces one start reminder and one end check-in.
12. Done closes the commitment once and cancels unsent messages.
13. Need more time records the session result and supports one newly confirmed next session.
14. Missed this session records the result and optionally supports one newly confirmed next session.
15. A recovery session after the target leaves the commitment overdue.
16. Non-response produces no additional notification.
17. Cancellation prevents unsent reminders and check-ins.
18. A service restart does not lose scheduled delivery.
19. Replayed webhooks and callbacks create no duplicate commitment, session, message, or outcome event.
20. Unauthorized Telegram and dashboard access expose no owner data.
21. The dashboard reflects the same live commitment, work-session, delivery, and outcome state.
22. Only allowed Calendar fields and read-only scopes are requested or exposed.
23. Calendar titles and full event objects are not sent to the model or retained as product history; only sanitized free/busy availability may reach the bounded agent.
24. All verification evidence is recorded in [`evidence.md`](./evidence.md).

## Definition of shipped

- The shaped user journeys work on the deployed Railway service.
- The non-cuttable loop is complete.
- Automated checks pass with `npm run check`.
- The deployment survives the restart and replay scenarios above.
- Evidence is recorded without secrets or unrelated personal data.
- Known limitations are visible and honest in Telegram and the dashboard.
