# S01-05 restart and recovery timeline

Source: `f2fe1934cd1f4af85c494543942cca38383f61a6`  
Result: PASS

The clean database test established this bounded sequence:

1. One durable pending schedule exists under one logical key.
2. Worker A claims it and receives the only current lease.
3. If the process stops before crossing the provider-send boundary, the lease
   expires and Worker B reclaims the same schedule using a new lease token
   without incrementing the attempt.
4. If delivery had started before the process stopped, expiry transitions the
   schedule to `delivery_unknown`; it is not automatically claimed again.
5. A restart does not create a second schedule or logical delivery identity.

Evidence command: `npm run test:db -- server/test/scheduler-db.integration.ts`
(3 passed, 0 failed). This covers AC2 and AC3.
