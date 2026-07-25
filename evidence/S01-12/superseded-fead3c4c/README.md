# Superseded release candidate

- Deployment: `fead3c4c-83ec-4ed6-8b28-dd0ac99ecccb`.
- Candidate 3 was healthy; partial production QA passed S1, S2, S3, S4, S5 after its bounded retry, S6, S20, S21, S22, S23, S24, S25, and S26.
- It was superseded before final sign-off by the owner-approved 30-second decision timeout and safe-diagnostics repair.
- S7 and later unlisted journeys were not run on this candidate.
- No down migration or rollback was performed.
- The manifest and rollback baseline are preserved byte-for-byte from the canonical artifacts.
