# Slice 02 verification evidence

Status: pending

Evidence must not contain secrets, decrypted session payloads, full Telegram webhook payloads, unrelated personal conversation content, Calendar titles, or full Calendar objects.

| Scenario | Required evidence | Status |
|---|---|---|
| Durable session restart | Encrypted session survives restart and continues the same conversational focus | Pass — S02-01 |
| History pagination | Agent retrieves an older required turn by opaque cursor without duplicating recent context | Pass — S02-01 |
| Multiple drafts | A second draft is created without overwriting the first | Pending |
| Ambiguous reference | No mutation and one clarification response | Pending |
| Preparation continuation | Duration and timing answers advance the focused draft through the agent | Pending |
| Create approval | Exact paused run resumes once and creates one commitment | Pending |
| Commitment edit | Approved edit rechecks time and replaces obsolete schedules atomically | Pending |
| Stale/replayed approval | No duplicate or mismatched mutation | Pending |
| Ordinary question | Natural answer with no product mutation | Pending |
| Privacy boundary | Provider storage disabled; persisted conversation and paused state encrypted | Pass — S02-01 storage boundary |
| Release restart | Railway restart preserves session, approvals, and scheduler state | Pending |
| Full regression | `npm run check` and Slice 01 critical paths pass | Pending |
