---
"cross-tab-kit": minor
---

Greenfield rewrite per `docs/architecture-greenfield.md` (breaking, pre-1.0):

- **Main entry is now scenario-level API only**: `withTabLock`, `tryWithTabLock`, `createLeadershipLoop`, `createLeadershipGate`, `createTtlDedupeCache` (plus their types, including `Logger`). `createPollLeaseClaimer`, `generatePollOwnerId`, and the safe-storage helpers moved to the new `cross-tab-kit/advanced` subpath, with `PollLeaseClaimResult` as a named type export.
- **New: `tryWithTabLock`** — skip-if-busy lock (Web Locks `ifAvailable`) returning `TabLockResult<T>`; the correct semantic for token-refresh dedupe.
- **`withTabLock` operation now receives a `TabLockContext`** (`{ timeoutSignal }`): `timeoutMs` expiry aborts it so a timeout becomes real cancellation. `options.signal` still only aborts the wait for the lock; the two signals stay independent.
- **New: `createLeadershipGate`** — caller-paced leadership (no timers): `acquire()` returns a `Tenure` (`{ fence, signal, isStillValid() }`) or null; `isStillValid()` is a locked re-claim + fence comparison that also renews; a `storage` event listener aborts the tenure signal the moment another tab's claim lands; `release()` is a synchronous tombstone.
- **New: `createLeadershipLoop`** — timer-driven leader election as a thin driver over the gate: `onLeadership(ctx)` fires once per tenure (including regain), `onLeadershipLost`, `releaseOnExit` (default true) via pagehide, idempotent `stop()`.
- **`createTtlDedupeCache` gains `has(id)`** (side-effect-free query) and **`options.maxEntries`** (evicts oldest-claimed entries; unbounded by default).
- Internals converged on a shared storage cell: JSON parse failures, garbage data, and quota write failures degrade silently everywhere; the dedupe cache's canonical form is a `Map` with writes via `Object.fromEntries`, so `__proto__`-style ids are safe. Preserved behavior: fence tombstones, finite-number validation of lease records, fail-open claims, `ttlMs` validation warnings, and no-write-on-no-change repeat claims.
