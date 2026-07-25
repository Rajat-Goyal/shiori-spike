# S01-09a provider privacy audit

Source: `f2fe1934cd1f4af85c494543942cca38383f61a6`  
Result: PASS

- The adapter rejects any Calendar ID other than `primary`.
- FreeBusy requests contain only the bounded range, Singapore time zone, and
  the primary Calendar identifier.
- Event reads request exactly
  `items(id,summary,start,end,transparency,recurrence,status)`.
- Availability consumes only busy intervals and check time. The unit oracle
  inserted a synthetic private title and identifier into the controlled
  provider response and proved neither appeared in the returned result.
- The token boundary decrypts and refreshes only server-side. It exposes no
  refresh credential or provider response object.
- The Calendar capability has a read method only; repeated reads are
  deterministic and create no commitment, session, schedule, action, or event.
- The database oracle passed 3/3 and confirmed no consequential product write.

No real provider request ran, and this artifact contains no credential,
identity, event title, attendee, description, or raw provider material.
