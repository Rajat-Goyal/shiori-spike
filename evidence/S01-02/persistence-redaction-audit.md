# S01-02 persistence and redaction audit

- Captured: 2026-07-24T13:02:17Z
- Commit: `02643983ee1b1df8fc72bec7a1cf75725ef523e2`
- Result: PASS
- Method: committed migration and test review plus read-only static and
  actual-environment leakage scans

## Persistence allowlist

| Logical record | Allowed columns verified |
|---|---|
| Telegram update | `update_id`, `processing_status`, `processing_result`, `received_at`, `processed_at` |
| Owner delivery | `singleton`, `private_chat_id`, `captured_at` |

The update record has a primary-key uniqueness boundary. Owner delivery has a
singleton primary key and a unique chat constraint. The claim function inserts
only update identity and bounded processing state, and captures the owner
delivery chat in the same database function. No request object is accepted by
the persistence interface.

## Forbidden-category audit

| Category | Database schema matches | Structured-log matches | Evidence matches |
|---|---:|---:|---:|
| Complete webhook payload | 0 | 0 | 0 |
| Message text or transcript | 0 | 0 | 0 |
| Credential or authorization value | 0 | 0 | 0 |
| Owner product-state disclosure | 0 | 0 | 0 |
| Raw request or raw error object | 0 | 0 | 0 |
| Personal identifier value in evidence | 0 | 0 | 0 |

The error path logs only a bounded failure class and a fixed event message.
Controlled verification uses an injected client and performs no external
Telegram request. The failure test checks that private message material,
credential material, and identifier material are absent from both the HTTP
response and captured logs.

## Repository and environment audit

- Telegram migration forbidden-retention-column scan: PASS.
- Structured logging call-site scan: PASS.
- Controlled-test external-client construction scan: PASS.
- Ignored and untracked local environment check: PASS.
- Actual secret and personal-value categories checked against tracked files: 11.
- Actual-value matches in tracked files: 0.

This artifact contains only schema names, aggregate counts, booleans, and audit
conclusions. It contains no database row values, request payload, raw log line,
credential, network endpoint, Telegram identifier value, or private test marker.
