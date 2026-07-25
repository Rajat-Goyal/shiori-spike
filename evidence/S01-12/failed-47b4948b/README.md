# Failed credential candidate

- Source commit: `f2fe193`
- Railway deployment: `47b4948b`
- Deployment status: `SUCCESS`; bounded health check: HTTP 200
- S1–S18: 0 pass, 3 fail, 15 blocked
- S19–S28: 2 pass, 2 fail, 6 blocked

The candidate was not shippable because its Supabase server key belonged to a
different project than its configured Supabase URL. This immutable evidence is
retained for audit and is superseded by the corrected-key release candidate.
