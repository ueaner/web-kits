---
"pending-task-kit": minor
---

Upgrade the internal `cross-tab-kit` dependency from `0.1.0` to `0.4.0` and rebuild
`crossTabPollLeaderElection`'s internals on top of `createLeadershipGate`/`Tenure` instead of
the lower-level `createPollLeaseClaimer`/`withTabLock` primitives (both still exist, now under
`cross-tab-kit/advanced` and `cross-tab-kit` respectively — this package's own public API is
unchanged). Observable behavior changes:

- Losing leadership to another tab mid-request now aborts the in-flight `handler.check()`'s
  `AbortSignal` the moment the other tab's claim lands (a `storage` event), not only on
  `stop()`. A handler that already wires `signal` into its own request gets real cancellation
  there too; a handler that ignores it is unaffected.
- An invalid `pollLeaseTtlMs` (non-positive, non-finite) now throws a `RangeError` when
  constructing `PendingTaskPoller` — but only when `crossTabPollLeaderElection` is on (the
  default); it's a no-op value when election is off, and no longer validated at all in that
  case (previously it was validated — and could throw — unconditionally).

Migration: if you compose `claimResultOnce` with `withTabLock`/`createTtlDedupeCache` per the
README's "Cross-tab duplicate-toast dedupe" section, `withTabLock`'s `options.waitTimeoutMs` is
now required (cross-tab-kit `^0.2.0`) — pass a real bound, or `Infinity` for the old unbounded
wait.
