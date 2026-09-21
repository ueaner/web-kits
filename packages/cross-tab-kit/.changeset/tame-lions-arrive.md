---
"cross-tab-kit": minor
---

Export `SHORT_TTL_WARN_MS` and `SLOW_WAIT_WARN_MS` (the previously-private thresholds behind `createLeadershipGate`'s two diagnostic warnings), and add `linkAbortSignal(source, target)` — the "abort `target`, propagating `source`'s reason, once `source` aborts (or immediately if it's already aborted); returns an unlink function" wiring that `TabLockContext.timeoutSignal`/`Tenure.signal`/`LeadershipContext.signal` are all meant to be composed with, extracted from `withTabLock`'s own internal signal-merging (which now uses it too — no behavior change there).

No existing API changed; this only adds new named exports to the main entry.
