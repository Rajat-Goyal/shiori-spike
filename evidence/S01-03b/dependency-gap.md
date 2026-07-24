# S01-03b dependency gap: correction versus collision

## Review marker and provenance

- Frozen dependency: `6c1a848 chore(S01-03a): close story`
- S01-03b start marker: `f2d658a chore(S01-03b): start story`
- Review point: clean worktree at `f2d658a`
- Review mode: architecture/security preflight using read-only inspection of the
  S01-03b story, draft rules, ADR decisions 2–4, and the S01-03a
  `DecisionEngine` contract.
- No source or state file was edited during the review. This evidence artifact
  is the only resulting filesystem change and is intentionally uncommitted.

## Reproduction of the contract ambiguity

Assume the same active draft exists in both scenarios:

```json
{
  "definitionOfDone": "Submit the project brief",
  "state": "collecting",
  "targetAt": "2026-07-29T10:00:00+08:00",
  "version": 4
}
```

The current owner turn is not retained in evidence. In scenario A, the owner
intends to correct that draft. In scenario B, the owner intends to request a
separate commitment while preserving the active draft.

The frozen S01-03a contract can validly return the following result for either
scenario:

### Scenario A — intended correction

```json
{
  "definitionOfDone": "Submit the project note",
  "durationMinutes": null,
  "inputClass": "explicit_commitment",
  "missingFields": [],
  "nextAction": "ready",
  "offerWorkWindowHelp": false,
  "possibleWorkSession": false,
  "response": "I have the details.",
  "simpleAction": true,
  "targetAt": "2026-07-30T10:00:00+08:00",
  "targetTimeZone": "Asia/Singapore",
  "timingConstraints": []
}
```

Required application transition: atomically update the active draft from
version 4 to version 5.

### Scenario B — intended separate commitment

```json
{
  "definitionOfDone": "Submit the project note",
  "durationMinutes": null,
  "inputClass": "explicit_commitment",
  "missingFields": [],
  "nextAction": "ready",
  "offerWorkWindowHelp": false,
  "possibleWorkSession": false,
  "response": "I have the details.",
  "simpleAction": true,
  "targetAt": "2026-07-30T10:00:00+08:00",
  "targetTimeZone": "Asia/Singapore",
  "timingConstraints": []
}
```

Required application transition: preserve the active draft and version 4
unchanged, then return the bounded collision response.

The two `DecisionResult` values are structurally and semantically identical,
but require mutually exclusive state transitions. The contract contains no
draft-relative intent or turn-relation field through which deterministic
application code can distinguish them.

## Why application inference is unsafe

- Comparing old and new values is insufficient. A correction may change one or
  every field, and a separate request may coincidentally reuse one or every
  field.
- Treating every difference as a correction can silently overwrite the active
  draft, directly violating AC4 and the slice rule that a new commitment
  request never overwrites an active draft.
- Treating every difference as a collision prevents accepted corrections and
  therefore also fails AC4.
- Matching phrases such as "change", "instead", or "new commitment" is an
  unbounded raw-text heuristic. It is language-sensitive, cannot be validated
  from the strict structured output, and moves authorization outside the
  reviewed decision contract.
- Replay protection solves duplicate delivery of the same Telegram update; it
  does not establish whether the first delivery was a correction or a separate
  request.

## Acceptance-criterion impact

### AC4 — blocked

AC4 requires all of the following at once:

- an accepted correction increments the version exactly once;
- replay does not increment it again;
- a second commitment request never silently overwrites the active draft.

Telegram update idempotency can satisfy the replay portion only after the
application has safely classified the first transition. The frozen S01-03a
output cannot authorize correction versus collision, so AC4 cannot be
independently verified without guessing.

### Permission flow — the same missing relation

AC2 requires a validated immediately following agreement before an implied
intention may begin a draft. The current three-way input class and
`DecisionResult` have no bounded value for permission accepted, permission
declined, or an unrelated turn. Inferring agreement from raw forms such as
"yes" has the same safety problem and would make an unrelated response capable
of beginning a draft.

## PM alternative: explicit `/correct`

A deterministic `/correct <replacement>` command could make correction intent
application-owned and avoid heuristic phrase matching. It is not the default
recommendation because:

- `/correct` is not part of the scoped Telegram command or inline-action set;
- it narrows the promised text-correction experience;
- it does not solve permission acceptance or refusal without adding another
  explicit command or scoped action.

This alternative is viable only if the owner approves the product-contract and
acceptance-criterion change and records the reason.

## Recommended prerequisite contract

Add a small prerequisite story, proposed as **S01-03a1 — Classify turns against
bounded draft context**, rather than modifying completed S01-03a commits.

The prerequisite should:

1. Replace the string-only decision input with the current owner turn plus a
   bounded structured conversation context containing only phase and validated
   draft fields, never prior raw messages or a transcript.
2. Add one strict, non-authorizing turn-relation enum that distinguishes no
   relation, new request, clarification continuation, correction, separate
   request, permission accepted, and permission declined.
3. Semantically validate each relation against the three-way input class and
   supplied conversation phase.
4. Preserve the existing no-tools, no-persistence, redaction, timeout, refusal,
   schema, and semantic-failure boundaries.
5. Leave every state transition to deterministic application code with
   database idempotency and version checks.

S01-03a1 should depend on S01-03a and block S01-03b. S01-03b should remain
blocked until the new contract is complete, then resume without heuristics or
raw-text authorization.
