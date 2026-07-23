# Shiori — first product iteration contract

Status: canonical contract for the first product iteration

## Full product vision

Shiori is a personal follow-through agent. Telegram is the primary interface for turning intentions into clear commitments, fitting them around real constraints, and following through. A web dashboard provides a complementary view of what Shiori is tracking and what has actually happened.

The first iteration delivers one complete product slice, not that entire vision.

## Product promise

For one owner, Shiori can:

- Distinguish an ordinary question, an implied intention, and an explicit commitment request in Telegram.
- Turn a confirmed intention into either a one-off commitment or a simple recurring commitment.
- Read relevant Google Calendar event details and availability when understanding or timing a commitment.
- Warn about a calendar conflict and suggest available alternatives without changing the calendar.
- Link a commitment to a matching calendar event after the user confirms the relationship.
- Send the scheduled Telegram reminder.
- Record Done, Snooze, or Skip responses.
- Show the same live commitments, calendar availability, and recorded outcomes in a read-only dashboard.

The whole slice uses one backend and source of truth. It is deployed to Railway as an always-available service so Telegram webhooks, scheduled reminders, the product API, and the dashboard remain reachable without a local development machine running.

## User and access boundary

- One configured Telegram owner.
- One owner-protected dashboard.
- No onboarding or multi-user account system.
- Telegram text messages only.

Google Calendar access is read-only. For events in the relevant time window, Shiori may access:

- Event identifier.
- Title.
- Start and end time.
- Time zone.
- Busy or free status.
- Recurrence information.
- Event status, such as confirmed or cancelled.

Descriptions, attendees, locations, attachments, conference links, and calendar-write permissions are outside the slice.

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
- A target time or a check-in time.
- A recurrence rule when it is recurring.
- An expected duration when the user asks Shiori to find time for the work.

Shiori asks one concise clarification question at a time. Before confirmation, the user may correct any detail or cancel without saving. After confirmation, Shiori calls the commitment tool and states exactly what was stored.

### Supported commitments

The first iteration supports:

- One-off commitments.
- Daily commitments at a fixed time.
- Weekly commitments on one or more selected weekdays at a fixed time.

More complex recurrence rules are outside the slice.

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

### Managing active commitments

Through Telegram, the owner can:

- Use `/status` to list active commitments.
- Use `/today` to see today's commitments alongside a concise calendar summary.
- Correct the target, check-in time, or recurrence of a saved commitment.
- Cancel a commitment.
- Pause or resume a recurring commitment.

Changes to saved commitments require an explicit confirmation before they take effect.

## Reminder and outcome loop

At the stored target or check-in time, Shiori sends one Telegram reminder for the commitment occurrence.

The user can respond:

- **Done** — records the occurrence as completed.
- **Snooze** — asks for a new reminder time and checks it against calendar availability.
- **Skip** — closes this occurrence without completing it.

Shiori does not repeatedly nag after non-response. Each delivery and response is recorded in a small append-only event ledger. Duplicate delivery protection prevents the same occurrence from being reminded twice.

For a recurring commitment, Done or Skip closes only the current occurrence. The recurrence remains active unless the user pauses or cancels it.

## Telegram-powered capabilities

The first iteration includes these Telegram behaviours:

- Three-way input classification.
- Structured extraction and missing-field handling.
- Permission before acting on an implied intention.
- One-off versus recurring commitment handling.
- Calendar-event matching, conflict explanation, and free-window suggestions.
- Confirmation before creating or changing a commitment.
- Orchestration of create, update, cancel, pause, and resume tools.
- `/status` and `/today` responses.
- Done, Snooze, and Skip outcome handling.
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
- Real Done, Snooze, Skip, and outstanding counts for the current week.
- A short event history derived from the live commitment event ledger.
- A commitment detail view or expansion showing its real reminder and outcome events.
- A visible last-updated time or refresh control.
- Populated, empty, loading, and error states.
- Responsive layouts for phone and desktop widths.

The dashboard is read-only. Telegram remains the place to create, change, complete, snooze, skip, pause, or cancel commitments.

The dashboard does not present behavioural patterns, personal inferences, coaching, or suggested experiments.

## Platform foundation

- Telegram webhook ingress and response delivery.
- Supabase schema and persistence client.
- Durable primitives for saving and changing commitments.
- A small append-only reminder and outcome event ledger.
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

Verify against the deployed Railway service:

1. Ordinary question → helpful answer, no commitment, and no dashboard change.
2. Implied intention → permission question and no save before agreement.
3. Explicit complete one-off commitment → one saved commitment visible through `/status` and the dashboard.
4. Simple recurring commitment → correct recurrence and next occurrence in Telegram and the dashboard.
5. Named calendar event → proposed match and no link until the user confirms it.
6. Proposed busy time → calendar conflict explanation and available alternatives without a calendar write.
7. Reminder time arrives → one Telegram reminder and one delivery event.
8. Done, Snooze, and Skip → correct occurrence state and live dashboard update.
9. Restart or repeated webhook delivery → no duplicate commitment, reminder, or outcome event.
10. Dashboard access outside the owner boundary → refused.
11. Calendar boundary → only the allowed event fields are requested or exposed, and no calendar-write permission is present.

Record the input, structured decision, tool call, stored state, Telegram response, and dashboard evidence in `PRODUCT-EVIDENCE.md`.

## Explicitly outside the first iteration

- Voice notes.
- Calendar descriptions, attendees, locations, attachments, conference links, or calendar writes.
- Creating, moving, or deleting meetings.
- Complex recurrence language.
- Multiple reminder escalation or persistent nagging.
- Adaptive reminder timing, wording, or frequency.
- Behavioural inference.
- Advanced or semantic memory.
- Memory export or complete deletion workflows.
- Prompt management platforms such as Langfuse.
- Formal eval platforms, repeated runs, trace review, cost analysis, or latency analysis.
- Dashboard write controls.
- Email, WhatsApp, wearables, or ambient listening.
- Multi-user onboarding and account management.
- Broad project management or autonomous consequential actions.

## Later product capabilities

Historical patterns, personal inferences, suggested experiments, richer coaching, and adaptive reminders may be introduced only after enough real outcome evidence exists and the product has the evaluation and prompt-management infrastructure to validate them safely.

Additional context sources such as email or activity data remain separate product decisions. Read-only Calendar events are the only external context in this slice.

## Decision record

- **Core product behaviour:** intent judgment, structured output, permission, one-off and simple recurring commitments, calendar-event matching, calendar-aware timing, commitment management, reminder outcomes, the live dashboard, and honest end-to-end evidence.
- **Platform foundation:** Telegram ingress, persistence, event ledger primitives, scheduler, read-only Calendar authorization and bounded event access, secret loading, owner boundaries, Railway configuration, duplicate protection, and recovery checkpoints.
- **Dashboard scope:** real commitments, relevant read-only calendar events, confirmed commitment-event relationships, real reminder outcomes, factual summaries, history derived from the event ledger, operational states, accessibility, and responsive design.
- **Deferred until supported by evidence and tooling:** behavioural inference, adaptation, coaching, experiments, advanced memory, prompt versioning, and formal evaluation.
- **Never represented with runtime mock data:** commitments, outcomes, calendar state, history, or dashboard summaries.
