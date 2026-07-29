# ADR — Durable conversational-agent orchestration

Status: accepted

Date: 2026-07-30

## Context

Slice 01 introduced an application-owned six-turn encrypted replay and a bounded OpenAI Agents SDK runtime. Typed Telegram replies still route through a generic decision classifier while preparation callbacks use a separate deterministic work-session flow. Callback choices, pending work-session stages, and older conversation history are therefore absent from the model's context.

The owner approved replacing that architecture with one durable conversational session and expanding the slice boundary where necessary for genuine usability.

## Decision 1: use the Agents SDK session strategy

Choose the documented `session` conversation strategy.

- Implement an application-owned durable session backed by encrypted Supabase storage.
- Pass the same session to each bounded agent run for the owner chat.
- Do not manually replay `result.history`.
- Do not use `conversationId` or `previousResponseId`.
- Keep Responses provider storage disabled.
- Store interrupted `RunState` separately from conversation items.

The application session, not the provider, owns retention, deletion, pagination, compaction, and encryption.

## Decision 2: one conversational orchestrator

All typed Telegram messages enter one conversational agent. Hard-coded text routing by work-session stage is removed.

The application supplies structured focus and pending-interaction context before the run. The model may ask questions, read more context, or select an allowlisted tool. Domain services remain deterministic tool handlers rather than a competing conversation loop.

Exact Telegram approval and outcome callbacks remain application-authorized inputs. Relevant choices become session context, while consequential callbacks resume the exact paused run or invoke an already-authorized idempotent domain transition.

## Decision 3: separate conversation, domain, and paused-run state

- Conversation state contains encrypted SDK-compatible items, working context, compaction checkpoints, and cursors.
- Domain state contains drafts, commitments, work sessions, schedules, outcomes, and append-only events.
- Paused-run state contains the encrypted exact SDK run interruption and authority binding.

Conversation evidence may inform intent but never authorizes a mutation. Every mutation names an exact entity and expected version.

## Decision 4: typed context and mutation tools

The orchestrator receives a strict allowlist:

- `read_context`
- `read_history`
- `list_commitments`
- `patch_draft`
- `request_sanitized_availability`
- `create_commitment`
- `update_commitment`

Names may be refined during implementation, but capability and authority boundaries may not be broadened without updating this ADR.

Read tools return only owner-authorized, bounded, sanitized data. `patch_draft` changes only unconfirmed state. `create_commitment` and `update_commitment` require human approval through SDK interruption.

## Decision 5: multiple drafts with one focus

Multiple non-terminal drafts may coexist. A session has at most one focused entity for a turn.

The model proposes focus changes, but application code validates ownership and existence. If more than one entity plausibly matches a reference, no mutation occurs until the owner clarifies.

## Decision 6: editable commitments

Confirmed commitments may be edited through an approval-gated versioned operation.

An edit transaction:

1. Locks and validates the current commitment version.
2. Validates the proposed definition, target, and work-session plan.
3. Rechecks sanitized Calendar availability when time changes require it.
4. Cancels obsolete unsent scheduled messages.
5. Writes replacement schedules with unique logical keys.
6. Appends events describing the approved change.
7. Commits atomically or changes nothing.

Terminal commitments cannot be reopened in this slice.

## Decision 7: natural conversation with controlled consequences

The agent may author ordinary answers and follow-up questions. Application-owned copy remains mandatory for:

- Approval summaries and buttons.
- Calendar conflict and unverified-save warnings.
- Successful or failed consequential mutations.
- Authorization, stale-version, replay, and privacy failures.

Every newly complete commitment still resolves the preparation question before creation approval. If the owner already supplied the answer, the agent incorporates it rather than asking a redundant generic question.

## Decision 8: durable encrypted retention with retrieval

The session stores the full encrypted conversation necessary for continuity rather than six turns. The working model context remains bounded through compaction and recent-item selection. `read_history` pages older items with opaque cursors and bounded per-run retrieval.

Retention is application-controlled and configurable. An explicit owner reset/forget operation closes or deletes conversational history without deleting authoritative commitments and audit events.

## Decision 9: preserve deterministic safety boundaries

The model never authenticates the owner, interprets raw callback authority, receives credentials, writes the database directly, schedules messages directly, or bypasses version and idempotency checks.

Google Calendar remains read-only and only sanitized free/busy information may reach the agent. Consequential actions remain exact, approval-gated, atomic, restart-safe, and replay-safe.

## Consequences

- Conversation becomes coherent across natural follow-ups, restarts, and commitment boundaries.
- Supabase becomes responsible for a larger encrypted conversation dataset and pagination.
- Multiple drafts and editable commitments require new versioned persistence and ambiguity handling.
- Context compaction and retrieval need explicit verification to avoid either context loss or unbounded provider input.
- The Slice 01 six-turn/24-hour and immutable-commitment decisions are superseded only for the behavior named in this slice; its delivery evidence remains historical and unchanged.
