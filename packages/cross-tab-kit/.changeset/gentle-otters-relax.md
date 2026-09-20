---
"cross-tab-kit": minor
---

`createLeadershipGate`'s `acquire()`/`Tenure.isStillValid()` and `createLeadershipLoop`'s ticks no longer reject when a claim's wait for the arbitration lock exceeds `waitTimeoutMs` — that's now treated the same as "someone else holds the lease right now" (both resolve `null`/`false` instead of one of them throwing), since both mean the same thing to the caller: not confirmed as leader this call. `withTabLock`/`tryWithTabLock` themselves are unaffected and still reject with a `TimeoutError`. Since the gate/loop path no longer throws for a wedged-holder wait, a wait running past half of `waitTimeoutMs` (capped at 5s) now logs a warning once per gate instance — the only remaining visibility into that case.
