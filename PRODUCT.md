# Shiori workshop slice — product contract

Status: canonical faculty reference for Build Day 1

Participants first record their own product judgment in `DECISION-LOG.md` and use Grill Me to challenge it. Faculty then reveal this file. From that point, everyone builds from this shared contract so the implementation and evidence remain comparable.

## Full product vision

Shiori is a personal follow-through agent. Telegram is the primary interface for turning intentions into clear commitments and following through. A later web dashboard provides a complementary weekly view of outcomes, evidence, patterns, and possible experiments.

The workshop does not attempt to build that complete product.

## Workshop promise

For one owner, Shiori can distinguish an ordinary question, an implied intention, and an explicit complete commitment in Telegram. It answers ordinary questions without saving, asks permission before acting on an implied intention, and can save a confirmed complete commitment through one tool before showing it through `/status`.

Alongside that working Telegram slice, the participant designs and builds one high-fidelity weekly dashboard screen from clearly labelled sample data. The dashboard is a design prototype, not a live product integration.

## User

- One configured Telegram owner.
- No onboarding or multi-user account system.
- Text messages only.

## Telegram input contract

Shiori distinguishes three cases:

1. **Explicit request** — “Remind me to send the proposal.”
   - Shiori may begin clarification immediately.
2. **Implied intention** — “I should send the proposal.”
   - Shiori asks whether the user wants help managing it.
   - Nothing is saved until the user agrees.
3. **Ordinary question** — “What makes a good proposal?”
   - Shiori answers without creating a commitment.

Before a commitment becomes active, it needs:

- A clear definition of done.
- A target time or check-in time.

The local decision core must represent missing or ambiguous information explicitly in structured output. If either required field is missing, the intended interaction is one concise clarification question at a time. After the user confirms the complete commitment, Shiori calls the save tool and states exactly what was stored.

Before confirmation, the user may correct a detail or cancel without saving. Editing and deletion after a save are explicit Day 1 limitations, so between-day use is restricted to low-risk commitments until a tested cleanup path is supplied.

## Participant-owned Day 1 behaviour

- An ordinary question creates no commitment.
- An implied intention asks permission before any save.
- The local decision core returns structured intent, extracted fields, missing fields, and next action.
- A confirmed complete commitment calls `save_commitment`.
- `/status` lists the owner’s active commitments with definition of done and check-in time.

## Supplied-base responsibilities

- Telegram ingress and response delivery.
- Supabase schema, persistence client, and `/status` read path.
- Safe loading of Telegram, model, and Supabase secrets.
- Binding to one configured Telegram owner and refusing other accounts.
- A durable `save_commitment` primitive with duplicate protection.
- A replaceable decision stub and a known-green recovery version.

These are required safety and reliability conditions before the workshop. Participants should understand them, but Day 1 does not spend the protected product-and-design time rebuilding this plumbing.

## Weekly dashboard design brief

The dashboard has one job:

> Help me understand how I followed through in a sample week and what I could try next.

It reads only `sample-week.json` and must clearly label the data as a sample. It includes:

- A concise weekly summary.
- Done, snoozed, and not-completed outcomes.
- A short “How Shiori helped” explanation.
- One possible pattern, explicitly labelled as an inference with supporting evidence.
- One narrow next experiment.
- A short commitment history.
- A normal state and an empty or insufficient-data state.

The dashboard is not a chat interface and is not connected to live Supabase data during Build Day 1.

## Day 1 observable smoke verification

This is a three-case smoke verification, not a formal evaluation.

### Telegram

- Ordinary question → no new row.
- Implied intention → permission question; no row yet.
- Explicit complete commitment → one row and visible through `/status`.

Record the input, structured decision, stored row count, and `/status` evidence in `DAY1-EVIDENCE.md`.

### Dashboard

- Reads the supplied fixture and no live product API.
- Clearly labels the week as sample data.
- Makes facts, inferences, and the next experiment distinguishable.
- Communicates that outcomes are self-reported.
- Works at phone and desktop widths.
- Provides a useful empty or insufficient-data state.

## Explicitly out of scope for Build Day 1

- Scheduled or proactive reminders
- Done, Snooze, Skip, or Pause responses
- Live weekly aggregation
- A live dashboard-to-Supabase connection
- Voice notes
- Google Calendar
- Recurring routines
- Capacity awareness
- Adaptive timing, wording, or frequency
- Behavioural inference generated from real history
- Memory export or complete deletion workflow
- Email, WhatsApp, or ambient listening
- Multi-user onboarding and account management
- Formal behavioural evaluation, repeated runs, trace review, cost, or latency analysis

## Deferred follow-through loop

Build Day 2 begins by evaluating the agent across varied inputs and repeated runs, using a behaviour rubric and at least one trace. It also tests duplicate handling, owner boundaries, invalid output, failure recovery, cost, and latency. Only then may it add one scheduled reminder, Done and Snooze responses, and a small event ledger. The dashboard should connect to live evidence only after that evidence exists.

## Decision record

- **Kept for participant work:** three-way input decision, structured output, permission, one save tool, `/status`, and honest smoke evidence. Each teaches product, AI, or engineering judgment.
- **Supplied as plumbing:** Telegram ingress, Supabase connection, secret loading, owner binding, duplicate protection, and recovery checkpoint. Participants inspect these boundaries without rebuilding them.
- **Kept as design scope:** one fixture-driven weekly dashboard, because it provides enough hierarchy, state, evidence, inference, voice, accessibility, and responsive-design work.
- **Cut:** everything requiring historical behaviour, proactive scheduling, calendar context, adaptation, or production dashboard integration.
