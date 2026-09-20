# cross-tab-kit

## 0.3.0

### Minor Changes

- 9515234: `createLeadershipGate`'s `acquire()`/`Tenure.isStillValid()` and `createLeadershipLoop`'s ticks no longer reject when a claim's wait for the arbitration lock exceeds `waitTimeoutMs` — that's now treated the same as "someone else holds the lease right now" (both resolve `null`/`false` instead of one of them throwing), since both mean the same thing to the caller: not confirmed as leader this call. `withTabLock`/`tryWithTabLock` themselves are unaffected and still reject with a `TimeoutError`. Since the gate/loop path no longer throws for a wedged-holder wait, a wait running past half of `waitTimeoutMs` (capped at 5s) now logs a warning once per gate instance — the only remaining visibility into that case.

## 0.2.0

### Minor Changes

- 04d226a: Greenfield rewrite per `docs/architecture-greenfield.md` (breaking, pre-1.0):

  - **Main entry is now scenario-level API only**: `withTabLock`, `tryWithTabLock`, `createLeadershipLoop`, `createLeadershipGate`, `createTtlDedupeCache` (plus their types, including `Logger`). `createPollLeaseClaimer`, `generatePollOwnerId`, and the safe-storage helpers moved to the new `cross-tab-kit/advanced` subpath, with `PollLeaseClaimResult` as a named type export.
  - **New: `tryWithTabLock`** — skip-if-busy lock (Web Locks `ifAvailable`) returning `TabLockResult<T>`; the correct semantic for token-refresh dedupe.
  - **`withTabLock` operation now receives a `TabLockContext`** (`{ timeoutSignal }`): `timeoutMs` expiry aborts it so a timeout becomes real cancellation. `options.signal` still only aborts the wait for the lock; the two signals stay independent.
  - **New: `createLeadershipGate`** — caller-paced leadership (no timers): `acquire()` returns a `Tenure` (`{ fence, signal, isStillValid() }`) or null; `isStillValid()` is a locked re-claim + fence comparison that also renews; a `storage` event listener aborts the tenure signal the moment another tab's claim lands; `release()` is a synchronous tombstone.
  - **New: `createLeadershipLoop`** — timer-driven leader election as a thin driver over the gate: `onLeadership(ctx)` fires once per tenure (including regain), `onLeadershipLost`, `releaseOnExit` (default true) via pagehide, idempotent `stop()`.
  - **`createTtlDedupeCache` gains `has(id)`** (side-effect-free query) and **`options.maxEntries`** (evicts oldest-claimed entries; unbounded by default).
  - **`withTabLock`'s `waitTimeoutMs` is now required**: an unbounded wait for the lock is how one tab's hung operation silently stalls every same-name waiter across all tabs, so the caller must make that tradeoff explicit (pass `Infinity` for the old unbounded behavior). `tryWithTabLock` never queues, so it has no `waitTimeoutMs` to set.
  - **Misconfiguration now fails fast**: an invalid `ttlMs`, `renewIntervalMs`, `maxEntries`, `waitTimeoutMs`, or `timeoutMs` throws a `RangeError` at construction or call time instead of degrading silently (or, for `ttlMs`, warning through a logger as in 0.1.0) — `createLeadershipLoop` additionally rejects a `renewIntervalMs` at or past `ttlMs`, since that lets the lease lapse between renewals and leadership flap between tabs.
  - Internals converged on a shared storage cell: JSON parse failures, garbage data, and quota write failures degrade silently everywhere; the dedupe cache's canonical form is a `Map` with writes via `Object.fromEntries`, so `__proto__`-style ids are safe. Preserved behavior: fence tombstones, finite-number validation of lease records, fail-open claims, and no-write-on-no-change repeat claims.

- 04d226a: Hardening on top of 0.1.0: poll-lease rejects lease records with non-finite numbers (an out-of-range literal like `1e999` parses to `Infinity` and could never lapse, blocking takeover forever) and validates `ttlMs` is a positive finite number (superseded by the greenfield-rewrite changeset in this same release: that validation now throws a `RangeError` rather than warning); `createTtlDedupeCache` gains the same `ttlMs` validation, no longer rewrites storage on a repeat claim when nothing expired, and treats malformed stored entries as expired instead of throwing.
