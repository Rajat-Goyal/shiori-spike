# Product slice 2 — A Conversation That Holds Together

Status: shaped and owner-approved

Parent contract: [`../../product.md`](../../product.md)

Architecture decision record: [`adr.md`](./adr.md)

Verification record: [`evidence.md`](./evidence.md)

## Purpose

Slice 01 proved the complete commitment, Calendar, reminder, outcome, dashboard, and deployment loop. Its bounded six-turn classifier and separate deterministic work-session conversation now make ordinary follow-up answers lose their conversational focus.

This slice makes Shiori a genuinely usable conversational commitment agent without giving the model database authority. One application-owned Agents SDK session follows the owner across bounded runs, while typed tools and application validation remain the only way to read or change product state.

## Product outcome

For the configured Telegram owner, Shiori can:

- Continue a conversation across service restarts and across completed commitments.
- Receive every typed message through one conversational agent rather than competing text routers.
- Begin with the current conversational focus and recent context, then retrieve older encrypted history by cursor when needed.
- Maintain multiple draft commitments while naming one focused draft for a turn.
- Extract fields in any natural order and ask only for information that is still missing.
- Ask every newly complete commitment whether preparation time is needed without losing the draft when the owner answers.
- Create a commitment only through an exact approval-gated tool call.
- Edit an existing commitment only through an exact approval-gated tool call.
- Explain ambiguity and ask which draft or commitment the owner means instead of silently overwriting state.
- Use natural agent-authored questions and answers while application-owned copy remains authoritative for approval summaries, safety warnings, and mutation results.

## Conversation contract

### One application-owned session

- One durable agent session is selected from the authenticated Telegram private-chat identity.
- One owner message starts one bounded Agents SDK run using that session.
- The run ends after the response, except when an approval-gated tool call is paused.
- Approval resumes the exact serialized run; it is not reclassified as a new owner message.
- OpenAI provider storage remains disabled. Supabase is the durable conversation source of truth.
- The session survives commitment confirmation and service restarts.
- The session may be explicitly reset or forgotten by the owner.

### Context

Every run receives:

- An immutable reference timestamp and configured time zone.
- The focused draft or commitment, if any.
- The exact pending interaction, including the last application question and relevant button choice.
- Authoritative structured draft, commitment, work-session, reminder, and outcome facts needed for the turn.
- A bounded recent working set from the durable session.
- Whether older history exists and the cursor required to retrieve it.

The model may page older history only through an allowlisted read tool. Older history is not blindly copied into every provider request.

### Focus and ambiguity

- More than one draft may exist.
- At most one draft or commitment is the conversational focus for a turn.
- Every mutation proposal includes the exact entity ID and expected version.
- A new request may create a new draft without overwriting a different draft.
- If the intended entity is ambiguous, the agent asks a clarification question and performs no mutation.
- Ordinary questions do not discard the current focus.

## Tool boundary

The allowlist may include:

- Read current conversational and product context.
- Read older conversation history by opaque cursor.
- List and read the owner's drafts, commitments, work sessions, and recent outcomes.
- Patch an unconfirmed draft with extracted semantic fields.
- Request sanitized Calendar availability.
- Request approval-gated commitment creation.
- Request approval-gated commitment editing or an existing supported commitment action.

Tools use strict schemas. Tool handlers authenticate and authorize through application context, validate entity versions and semantic invariants, and invoke application services. The model never receives database credentials, calls repositories directly, interprets Telegram callback authority, or treats its own prose as authorization.

## Draft and commitment rules

- Multiple drafts may coexist, but every tool call targets one exact draft and version.
- Draft fields may be supplied or corrected in any order.
- A newly complete commitment must explicitly resolve whether preparation time is needed before creation can be approved.
- Draft changes are non-consequential and do not create scheduled messages.
- Commitment creation requires owner approval.
- Material edits to an existing commitment require owner approval.
- Editing a target or work-session plan rechecks Calendar where applicable, invalidates stale suggestions, and atomically replaces obsolete unsent scheduled messages.
- Completed or cancelled commitments remain terminal.
- Every committed mutation is idempotent and append-only audit events preserve what changed.

## Work-session conversation

- The conversational agent owns typed preparation answers, duration answers, timing constraints, and owner-selected times.
- Deterministic work-session services remain authoritative behind tools.
- The pending preparation question and work-session planning state are always visible in structured context.
- Supported duration is a bounded positive number of minutes rather than only 30, 60, 90, or 120.
- Calendar suggestions retain an explicit scheduling granularity and never silently relax owner constraints.
- At most one next planned work session per commitment remains in force.

## Persistence and retention

Persist application-encrypted:

- Owner and assistant conversation items.
- Relevant button choices and application questions needed for conversational continuity.
- Sanitized tool-call and tool-result items needed by the SDK session.
- Compaction checkpoints and history cursors.
- The exact paused SDK run state for an unresolved approval.

Persist separately as authoritative product state:

- Drafts and their versions and focus.
- Commitments, work sessions, scheduled messages, outcomes, and append-only events.

Do not persist:

- Model chain-of-thought.
- Secrets, OAuth tokens, authorization headers, or complete Telegram webhook payloads.
- Full Calendar objects, event descriptions, attendees, locations, or unrelated events.
- Decrypted session or paused-run state.

Conversation retention is application-controlled and configurable. It is not tied to a six-turn window or draft completion. The owner must have an explicit reset/forget path before conversation history is treated as permanent.

## Preserved safety and product boundaries

- One configured owner, Telegram private chat, and owner-protected dashboard.
- Read-only primary Google Calendar and sanitized free/busy exposure.
- No silent target changes, automatic recovery scheduling, or repeated nagging.
- No Calendar writes.
- No model-selected arbitrary tools.
- Human approval for consequential creation or editing.
- Application validation, compare-and-swap versions, idempotency, and atomic database transitions.
- One next planned work session per commitment.

## Deferred

- Recurring commitments.
- Automatic behavioural or preference memory.
- Voice, image, file, group-chat, or channel input.
- Multiple owners or Google accounts.
- Calendar writes or continuous Calendar monitoring.
- Dashboard commitment mutation.
- Adaptive reminder escalation, weekly coaching, analytics, or experiments.

## Acceptance criteria

1. A follow-up answer to a pending preparation or timing question advances the same focused draft after a process restart.
2. The agent can retrieve older encrypted conversation history by cursor when recent context is insufficient.
3. A new promise can create a second draft without overwriting a different focused or parked draft.
4. Ambiguous references ask for clarification and change nothing.
5. Commitment creation pauses for explicit approval and resumes the exact run.
6. An approved commitment edit atomically updates the exact current version, rechecks Calendar when needed, and replaces obsolete unsent schedules without duplication.
7. A stale, replayed, rejected, or mismatched approval cannot mutate product state.
8. Flexible preparation durations and timing constraints continue through the agent instead of bypassing it.
9. Ordinary questions answer naturally without changing drafts or commitments.
10. Provider storage remains disabled and retained conversation state is application-encrypted.
11. A service restart preserves conversational continuity, paused approvals, and scheduled delivery.
12. The deployed Telegram flow passes the representative create, prepare, approve, correct, edit, restart, and replay scenarios.

## Definition of shipped

- All typed Telegram messages use the unified conversational agent.
- The existing Slice 01 product loop remains green.
- The new durable-session, multi-draft, edit, approval, restart, and privacy scenarios pass.
- `npm run check` passes.
- Database migrations are applied to the configured Supabase environment.
- The current branch is pushed and the dedicated Railway service is deployed successfully.
- Evidence contains no secrets or unrelated personal conversation content.
