# S01-07 token exposure audit

- Commit: `670a5c21101deb93ff8fbe09ed1f871bc39bb8d1`
- Generated: `2026-07-24T18:21:36Z`
- Controlled gate: **PASS**
- Real Google owner-assisted Connect: **PASS**
- Real Google owner-assisted Reconnect: **PASS**

## Exposure matrix

| Surface | Verification | Result |
|---|---|---|
| Browser production bundle | Three built files scanned against seven loaded secret classes, seven controlled sentinels, and seven forbidden credential patterns | 0 matches |
| Browser persistence/direct data access | Built bundle scanned for `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB, Supabase REST paths, and Supabase environment identifiers | 0 matches |
| OAuth callback URL and response | Controlled callback used unique code/state sentinels; redirect was the clean application root with no query or fragment, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer` | PASS |
| Structured logs | Callback path, code/state keys, and unique code/state values were absent from the captured logger stream | 0 matches |
| Provider response retention | A controlled access token and unrelated provider field were discarded before replacement | 0 persisted matches |
| Database schema | Three tables and 26 allowlisted columns inspected; eight forbidden plaintext/provider column names checked | 0 forbidden columns |
| Database rows | Plaintext refresh-token sentinel absent; attempts/outcomes were one-use; failed reconnect snapshots remained byte-for-byte unchanged | PASS |
| Real browser return | Original tab visibly reported Reconnect success; independent tab confirmed a clean root URL and connected read-only primary-Calendar state without returning the identity value | PASS |
| Real database row | Attempts/outcomes drained; singleton connection has a valid authenticated-encryption envelope, exact approved scope policy, literal `primary`, connected status, and valid timestamps | PASS |
| Evidence files | Loaded secret values and controlled sentinel values scanned after artifact generation | 0 matches |

The public OAuth client identifier, opaque OAuth state, nonce, and PKCE challenge necessarily travel through the authorization request. They are not credentials. The callback renders no JavaScript and redirects immediately to a clean URL.

## Authenticated-encryption envelope

| Property | Controlled result |
|---|---|
| Algorithm | AES-256-GCM |
| Encryption key | Canonical base64, exactly 32 bytes |
| Nonce | Fresh 12-byte value |
| Authentication tag | 16 bytes |
| Ciphertext | Non-empty canonical base64; differs for repeated plaintext under fresh nonces |
| Key version | Positive integer stored with the envelope |
| Authenticated context | Schema, configured email, owner reference, purpose, and key version |
| Ciphertext tamper | Rejected |
| Nonce tamper | Rejected |
| Authentication-tag tamper | Rejected |
| Context tamper | Rejected |
| Wrong key or version | Rejected/fails closed |
| Empty, malformed, or wrongly-sized fields | Rejected |

## Rotation and reconnect

- A stored key-version mismatch is represented as authorization expired and offers Reconnect; no unknown-key decryption is attempted.
- Reconnect writes a fresh current-version envelope through one singleton upsert.
- The connection row count remains exactly one.
- Denial, provider failure, and owner-identity mismatch preserve the prior connection row byte-for-byte.
- Successful Reconnect replaces the prior encrypted envelope and metadata atomically.

## Database boundary and minimization

The persisted Google data is limited to:

- digests and an encrypted PKCE verifier for a bounded attempt;
- a bounded one-use outcome;
- verified owner email;
- encrypted refresh-token ciphertext, nonce, tag, and key version;
- the approved normalized scope set;
- the literal Calendar identifier `primary`;
- connection status and minimal timestamps.

RLS is enabled. Anonymous and authenticated roles have no table access or OAuth RPC execution; only the server-side service role receives the bounded grants. No authorization code, access token, ID token, provider response, client secret, code verifier, or plaintext refresh token has a persistence column.

## Availability isolation

With the Google service forced unavailable through controlled injection:

- Google state returned `unavailable` with HTTP 200;
- the protected dashboard summary returned HTTP 200 with its commitment data intact;
- the authorized Telegram webhook path returned HTTP 200 and invoked its handler once;
- `/api/health` returned HTTP 200 with `status: ok`.

This proves isolation for every currently implemented non-Calendar surface. S01-03b/S01-03c and release verification must retest the same invariant when later commitment-write behavior exists.

## Final clean-checkout verification

- Focused OAuth: 19/19 passed.
- Focused Chromium: 13/13 passed.
- Full check: typecheck, 213/213 server tests, both production builds, and
  46/46 desktop/mobile browser tests passed.
- Exact database command: 5/5 passed against a fresh disposable
  `shiori-s01-07-qa` stack containing only committed migrations.
- The disclosed shared S01-03b conversation fixture was not used as final
  evidence and was not deleted or changed.
- Because the database tests deliberately require API port 54321, only the
  shared gateway was briefly paused. Shared DB, REST, and Auth stayed running;
  the disposable stack was removed afterward, the shared gateway was restored,
  and its health check returned HTTP 200.
- All five evidence artifacts were scanned against 11 loaded local sensitive
  values: zero matches. The four text artifacts contain zero recognizable
  email, token, client-id, JWT, or callback-query patterns. Independent visual
  inspection confirms the screenshot contains only the controlled synthetic
  identity fixture, never the configured owner value.

## Owner-assisted follow-up

After the exact local callback and Testing-mode account were configured, the
owner completed real Connect and Reconnect through the protected dashboard.

The bounded browser proof confirmed:

- a clean application-root return with no query or fragment;
- the one-use `Google Calendar reconnected.` success notice in the original tab;
- Connected state, a nonempty owner display, `Primary calendar · Read-only`,
  `Calendar not checked yet`, and the Reconnect action;
- the same connected state in a fresh independent authenticated tab after the
  one-use outcome had been consumed.

Sanitized post-smoke database inspection confirmed zero attempts, zero active
attempts, zero outcomes, and exactly one connection. The singleton connection
has a valid authenticated-encryption envelope, the exact approved normalized
scope policy, literal Calendar identifier `primary`, nonempty configured-owner
metadata, connected status, and valid timestamps. Commitments remained at zero.
The later-slice `work_sessions`, `scheduled_messages`, and `commitment_events`
relations do not yet exist in this pre-S01-03c schema, so the OAuth smoke could
not have created rows in them.

The evidence intentionally records no email, authorization URL, callback query,
OAuth state, authorization code, token, client secret, raw provider payload, or
encrypted credential material. The screenshot remains the controlled synthetic
four-state contact sheet because a live connected panel necessarily renders the
configured owner email.
