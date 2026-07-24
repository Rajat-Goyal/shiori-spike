# S01-07 token exposure audit

- Commit: `670a5c21101deb93ff8fbe09ed1f871bc39bb8d1`
- Generated: `2026-07-24T15:03:45Z`
- Controlled gate: **PASS**
- Real Google owner-assisted Connect: **BLOCKED**
- Real Google owner-assisted Reconnect: **PENDING**

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

## Owner-assisted follow-up

The owner authenticated to the protected local dashboard and initiated Connect once. Google rejected the request before consent with the bounded failure class `redirect_uri_mismatch` because the required local callback is not registered.

The attempt produced:

- no consent or scope grant;
- no provider API or token exchange;
- no application callback;
- no Google connection row or token;
- no Reconnect attempt.

The temporary local server was stopped. Disposable local Supabase was reset, and attempts/outcomes/connection counts were confirmed as `0/0/0`.

Connect remains **BLOCKED** on callback registration. Reconnect remains **PENDING**. A later sanitized owner-assisted run must confirm matching identity, the provider-returned granted scopes, successful Connect and Reconnect, singleton replacement, and the clean browser return without recording URLs, state, client identifiers, codes, tokens, email, or encrypted credential material in evidence.
