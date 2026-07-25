# Failed release candidate `f65efa2`

This immutable release attempt is retained for audit and is not valid shipment evidence.

- The manifest pinned deployment `cefa97e1-d307-47b7-95ae-88b989ed19b3`.
- Independent QA found that the dedicated Railway runtime used a loopback `SUPABASE_URL` while the release manifest and migration ledger targeted the hosted Supabase project.
- Authenticated database-backed owner surfaces were unavailable, so S01-12 AC1, AC2, and AC5 failed.
- The verifier did not compare deployed Railway database-target variables with its local release target.
- The dedicated service variable was corrected without changing any other variable, creating configuration-repair deployment `b2b126f5-64b5-45fb-883d-73061cb4620d`.

The canonical `evidence/S01-12/release-manifest.json` and `rollback-baseline.json` paths remain reserved for the next fully verified release candidate.
