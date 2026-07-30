# Shiori — product contract

Status: canonical product contract, delivered incrementally through bounded product slices

## Full product vision

Shiori is a personal follow-through agent. Telegram is the primary interface for turning intentions into clear commitments, fitting them around real constraints, and following through. A web dashboard provides a complementary view of what Shiori is tracking and what has actually happened.

The product is delivered through shaped vertical slices. Each slice must ship a meaningful end-to-end user experience while moving toward this contract; no slice is required to implement the entire contract at once.

## Product slices

1. [A Promise That Fits](./product-slices/01-a-promise-that-fits/scope.md) — the first product slice turns a one-off intention into a confirmed, Calendar-aware commitment, follows one work session at a time, records what happened, and shows the same live state on the dashboard.
2. [A Conversation That Holds Together](./product-slices/02-a-conversation-that-holds-together/scope.md) — the second product slice replaces the form-like conversational workflow with one durable, tool-using agent session that can preserve focus, retrieve its own history, manage concurrent drafts, and create or edit commitments through explicit approval.

Each slice keeps its scope, architecture decisions, and evidence inside its own folder. Slice-specific behavior is not represented with runtime mock data.

## Product promise

For one owner, Shiori can:

- Distinguish an ordinary question, an implied intention, and an explicit commitment request in Telegram.
- Turn a confirmed intention into either a one-off commitment or a simple recurring commitment.
- Read relevant Google Calendar event details and availability when understanding or timing a commitment.
- Warn about a calendar conflict and suggest available alternatives without changing the calendar.
- Link a commitment to a matching calendar event after the user confirms the relationship.
- Optionally schedule one work session at a time without creating a Calendar event.
- Send scheduled Telegram reminders and work-session check-ins.
- Record commitment and work-session outcomes, including Done, More work needed, Missed this session, Snooze, or Skip where the relevant flow supports them.
- Show the same live commitments, calendar availability, and recorded outcomes in a read-only dashboard.

The product uses one backend and source of truth. It is deployed to Railway as an always-available service so Telegram webhooks, scheduled reminders and check-ins, the product API, and the dashboard remain reachable without a local development machine running.

## User and access boundary

- One configured Telegram owner.
- One owner-protected dashboard.
- No onboarding or multi-user account system.
- Telegram text messages plus Shiori-provided inline action buttons.
- No Telegram voice, images, files, group chats, channels, or arbitrary interactive UI.

Google Calendar access is read-only. For events in the relevant time window, Shiori may access:

- Event identifier.
- Title.
- Start and end time.
- Time zone.
- Busy or free status.
- Recurrence information.
- Event status, such as confirmed or cancelled.

Descriptions, attendees, locations, attachments, conference links, and calendar-write permissions are outside the product contract.

Shiori requests calendar data only when it is relevant to the current interaction, reminder, `/today` response, or dashboard time window. It does not copy complete calendar event records into long-term memory.

## Commitment contract

### Input decisions

Shiori distinguishes three cases:

1. **Explicit request** — “Remind me to send the proposal tomorrow.”
   - Shiori may begin clarification immediately.
2. **Implied intention** — “I should send the proposal tomorrow.”
   - Shiori asks whether the user wants help managing it.
   - Nothing is saved until the user agrees.
3. **Ordinary question** — “What makes a good proposal?”
   - Shiori answers without creating a commitment.

The decision core represents intent, extracted fields, missing fields, and next action in structured output.

### Required commitment information

Before a commitment becomes active, it needs:

- A clear definition of done.
- A target time for a one-off commitment or an occurrence time for a recurring commitment.
- A recurrence rule when it is recurring.
- An expected duration when the user asks Shiori to find time for the work.

Shiori asks one concise clarification question at a time. Before confirmation, the user may correct any detail or cancel without saving. After confirmation, Shiori calls the commitment tool and states exactly what was stored.

### Supported commitments

The product contract supports:

- One-off commitments.
- Daily commitments at a fixed time.
- Weekly commitments on one or more selected weekdays at a fixed time.

More complex recurrence rules are outside the product contract.

### Calendar-aware timing

When a commitment refers to a named event, Shiori may search the relevant calendar window for a likely match.

- Shiori explains the proposed match, including the event title and time.
- The user confirms the relationship before Shiori links the commitment to the event.
- A calendar event never becomes a commitment solely because Shiori found it.
- The stored relationship references the calendar event identifier rather than copying the complete event into Shiori's memory.
- If a linked event changes, Shiori may flag that the commitment timing should be reviewed, but it does not silently change the commitment.

When a commitment has a proposed time, Shiori checks relevant Calendar events and availability before asking for final confirmation.

- If the proposed time is free, Shiori confirms it normally.
- If it overlaps a busy period, Shiori explains the conflict and offers up to two nearby free alternatives.
- If the user asked Shiori to find time and supplied an expected duration, Shiori offers free windows that can fit that duration.
- The user may keep the original time despite the warning.
- Shiori never creates, moves, or deletes calendar events.
- Calendar context is advisory. An event or busy period is not treated as proof that the commitment cannot be completed.

These are fixed rules. Shiori does not learn or adapt reminder timing from behaviour.

### Work sessions

A commitment represents the promised outcome. A work session is an optional scheduled attempt that supports completing it.

- Shiori offers help finding work time only when the commitment appears to need work before its target and no work window was already supplied.
- A work session has an explicit start, end, and expected duration.
- The commitment target remains separate and is never silently moved.
- Shiori plans at most one next work session at a time.
- A commitment may retain the history of multiple past work sessions.
- A session scheduled after the target is a recovery session; the unchanged commitment remains overdue until it is done or cancelled.
- Every additional session requires an explicit user decision and confirmation.
- Work sessions do not create, reserve, move, or delete Google Calendar events.

### Managing active commitments

Through Telegram, the owner can:

- Use `/status` to list active commitments.
- Use `/today` to see today's commitments alongside a concise calendar summary.
- Correct the target, check-in time, or recurrence of a saved commitment.
- Cancel a commitment.
- Pause or resume a recurring commitment.

Changes to saved commitments require an explicit confirmation before they take effect.

## Reminder and outcome loop

For a simple action without an expected duration, Shiori sends one Telegram reminder at the stored target or occurrence time.

The user can respond:

- **Done** — records the occurrence as completed.
- **Snooze** — asks for a new reminder time and checks it against calendar availability.
- **Skip** — closes this occurrence without completing it.

For a duration-based work session:

- Shiori sends one reminder at the session start.
- Shiori sends one check-in at the session end unless the commitment was already completed or cancelled.
- **Done** closes the commitment when its definition of done has been achieved.
- **More work needed** records partial progress without inferring a percentage and may begin the explicitly confirmed scheduling of one next work session.
- **Missed this session** records that no work occurred and may begin the explicitly confirmed scheduling of one next work session.

Shiori does not repeatedly nag after non-response. The planned end check-in is part of a confirmed work session, not an escalation. No further message follows an unanswered reminder or check-in.

Each delivery and response is recorded in a small append-only event ledger. Duplicate delivery protection prevents the same logical reminder or check-in from being deliberately sent twice.

For a recurring commitment, Done or Skip closes only the current occurrence. The recurrence remains active unless the user pauses or cancels it.

## Telegram-powered capabilities

The product contract includes these Telegram behaviours:

- Three-way input classification.
- Structured extraction and missing-field handling.
- Permission before acting on an implied intention.
- One-off versus recurring commitment handling.
- Calendar-event matching, conflict explanation, and free-window suggestions.
- Confirmation before creating or changing a commitment.
- Inline Confirm, Cancel, Done, More work needed, and Missed this session actions where applicable.
- Orchestration of create, update, cancel, pause, and resume tools.
- `/status` and `/today` responses.
- Simple reminder and duration-based work-session outcome handling.
- Clear statements of what was read, suggested, saved, or changed.

## Live dashboard

The dashboard has one job:

> Show me what Shiori is tracking, how it relates to my calendar, and what has actually happened.

It reads only live product data. Runtime sample or fixture data is not allowed.

### Dashboard capabilities

The dashboard includes:

- A factual current-state summary.
- Active, due-today, and overdue commitment counts.
- Today's commitments ordered by target or check-in time.
- Upcoming one-off commitments.
- Active and paused recurring commitments.
- Each commitment's definition of done, next occurrence, and recurrence rule.
- A view of today's relevant calendar events using only the allowed read-only fields.
- Confirmed relationships between commitments and calendar events.
- Calendar-conflict indicators for commitments whose timing overlaps a busy period.
- Up to two upcoming free windows when duration data makes that calculation possible.
- Real Done, More work needed, Missed this session, Snooze, Skip, and outstanding counts where those outcomes apply.
- Work-session history showing planned time, reminder and check-in delivery, and recorded result.
- A short event history derived from the live commitment event ledger.
- A commitment detail view or expansion showing its real reminder and outcome events.
- A visible last-updated time or refresh control.
- Populated, empty, loading, and error states.
- Responsive layouts for phone and desktop widths.

The dashboard is read-only for commitments. Telegram remains the place to create, change, complete, schedule more work, snooze, skip, pause, or cancel commitments. The dashboard may manage the read-only Google connection required to provide Calendar context.

The dashboard does not present behavioural patterns, personal inferences, coaching, or suggested experiments.

## Platform foundation

- Telegram webhook ingress and response delivery.
- Supabase schema and persistence client.
- Durable primitives for saving and changing commitments.
- Durable work-session and scheduled-message primitives.
- A small append-only reminder, check-in, and outcome event ledger.
- Owner-scoped read primitives shared by Telegram and the dashboard API.
- A reliable scheduler primitive with duplicate delivery protection.
- Google Calendar authorization and a bounded `get_calendar_context` primitive that returns only the allowed fields for a specified time window.
- Safe loading of Telegram, model, Supabase, Calendar, and dashboard-access secrets.
- Binding to one configured Telegram owner and refusing other accounts.
- An owner-only dashboard access gate.
- Railway service configuration, public routing, and a health endpoint.
- A replaceable decision stub and a known-green recovery version.

These are platform foundations rather than end-user product capabilities.

## Observable verification

This is an end-to-end smoke verification, not a formal behavioural evaluation.

Verify the applicable behavior against the deployed Railway service:

1. Ordinary question → helpful answer, no commitment, and no dashboard change.
2. Implied intention → permission question and no save before agreement.
3. Explicit complete one-off commitment → one saved commitment visible through `/status` and the dashboard.
4. Simple recurring commitment → correct recurrence and next occurrence in Telegram and the dashboard.
5. Named calendar event → proposed match and no link until the user confirms it.
6. Proposed busy time → calendar conflict explanation and available alternatives without a calendar write.
7. Simple reminder time arrives → one Telegram reminder and one delivery event.
8. Duration-based work session → one start reminder, one end check-in, and no follow-up after non-response.
9. Done, More work needed, and Missed this session → correct commitment or session state and live dashboard update.
10. Explicit continuation → at most one newly confirmed next work session, without moving the target.
11. Restart or repeated webhook delivery → no duplicate commitment, reminder, check-in, or outcome event.
12. Dashboard access outside the owner boundary → refused.
13. Calendar boundary → only the allowed event fields are requested or exposed, and no calendar-write permission is present.

Record the input, structured decision, application action, stored state, Telegram response, and dashboard evidence in the applicable product slice's evidence file.

## Explicitly outside the product contract

- Voice notes.
- Calendar descriptions, attendees, locations, attachments, conference links, or calendar writes.
- Creating, moving, or deleting meetings.
- Complex recurrence language.
- Multiple reminder escalation or persistent nagging after an unanswered reminder or check-in.
- Adaptive reminder timing, wording, or frequency.
- Behavioural inference.
- Advanced or semantic memory.
- Memory export or complete deletion workflows.
- Formal eval platforms, repeated runs, automated scoring, or experiment tracking.
- Dashboard commitment write controls.
- Email, WhatsApp, wearables, or ambient listening.
- Multi-user onboarding and account management.
- Broad project management or autonomous consequential actions.

## Later product capabilities

Historical patterns, personal inferences, suggested experiments, richer coaching, and adaptive reminders may be introduced only after enough real outcome evidence exists and the product has the evaluation and prompt-management infrastructure to validate them safely.

Additional context sources such as email or activity data remain separate product decisions. Read-only Calendar events are the only external context in the current product contract.

## Decision record

- **Core product behaviour:** intent judgment, structured output, permission, one-off and simple recurring commitments, calendar-event matching, calendar-aware timing, optional work sessions, commitment management, reminders, check-ins, outcomes, the live dashboard, and honest end-to-end evidence.
- **Platform foundation:** Telegram ingress and inline actions, persistence, event-ledger primitives, scheduler, read-only Calendar authorization and bounded event access, secret loading, owner boundaries, Railway configuration, duplicate protection, and recovery checkpoints.
- **Dashboard scope:** real commitments, relevant read-only calendar events, confirmed commitment-event relationships, real work-session and reminder outcomes, factual summaries, history derived from the event ledger, operational states, accessibility, and responsive design.
- **Observability:** Langfuse carries agent traces and versioned prompts. Tracing is optional at runtime: the application runs identically with the keys absent. Traces include prompt and completion content, which is a deliberate owner decision — a trace without it cannot explain why a proposal failed validation.
- **Deferred until supported by evidence and tooling:** behavioural inference, adaptation, coaching, experiments, and formal evaluation.
- **Never represented with runtime mock data:** commitments, outcomes, calendar state, history, or dashboard summaries.
