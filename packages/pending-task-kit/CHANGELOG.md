# pending-task-kit

## 0.5.0

### Minor Changes

- d955de3: Upgrade the internal `cross-tab-kit` dependency from `0.1.0` to `0.4.0` and rebuild
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

## 0.4.0

### Minor Changes

- e34ae40: `silentOnSuccess`/`silentOnFailure` no longer suppress `onResult` (or the DOM event/cross-tab
  relay) entirely — they now only set `detail.silent` on the dispatched
  `PendingTaskResultEventDetail`, which `onResult` can check itself. The engine has no notion of
  what a "notification" is (per this package's own "notification channel deliberately not part
  of this package"), so having it withhold `onResult` on your behalf assumed `onResult` only ever
  means "show a toast" — not true for callers that also use it to switch a view or invalidate a
  cache on an outcome they don't want to toast for.

  Migration: a caller that relied on the old "silent = `onResult` never runs" behavior should add
  `if (detail.silent) return` (or equivalent) as the first line of its own `onResult`.

  `expired` is unaffected — it still never reaches `onResult` at all, regardless of any flag.

- 58fc7f9: **Breaking**: `withTabLock`, `createTtlDedupeCache`, `createPollLeaseClaimer`, `generatePollOwnerId`, and the safe-storage helpers are no longer exported from this package — they've moved to [`cross-tab-kit`](https://github.com/ueaner/cross-tab-kit), which this package now depends on internally for its own cross-tab coordination. None of them had a real dependency on the "task" domain, so they're better served as their own standalone package.

  Migration: if you were composing `claimResultOnce` with `withTabLock`/`createTtlDedupeCache` per the README's "Cross-tab duplicate-toast dedupe" section, `pnpm add cross-tab-kit` and import them from there instead — the API is unchanged, only the package they come from.

  Two `createTtlDedupeCache` edge behaviors did change with the move (both improvements, but "the API is unchanged" above refers to the signature, not these): a malformed stored entry (null, or a non-numeric `claimedAt` — the state is hand-editable JSON) is now treated as already expired instead of throwing, and a repeat claim with nothing expired no longer rewrites localStorage (the claim window is unchanged either way).

  `clearResultRelay`/`parseResultRelay`/`writeResultRelay` are unaffected — they stay here, since they're genuinely task-domain-coupled (they validate a `PendingTask` shape).

## 0.3.0

### Minor Changes

- 7d526f3: Add a `PendingTaskLogger` diagnostic-warning channel (`{ warn(message) }`, defaulting to
  `console`) to `createPendingTaskStore`, `createPollLeaseClaimer`, and `PendingTaskPoller`, so
  the package's warnings can be routed into an app's own telemetry/logging. Two new runtime
  warnings use it: a task whose `type` matches no registry entry now warns once per type per
  poller (previously it sat silently until its TTL expired), and `start()`-ing a second poller
  on the same store in the same tab (which can never receive storage/relay events) now warns
  instead of failing silently. The store's persisted state is also now versioned
  (`version: 1` with a pass-through `migrate`) so future shape changes can migrate old data
  instead of zustand discarding it — pre-versioning entries hydrate unchanged.

### Patch Changes

- ffe69a5: Declare `engines: { node: ">=24" }` in package.json. Consumers installing the package on Node < 24 will now see an EBADENGINE warning; supported runtimes are unaffected.

## 0.2.0

### Breaking Changes

- **ESM-only**: dropped the CommonJS build — the `require` export conditions and `.cjs`
  artifacts that 0.1.0 shipped are gone. ESM `import` is unaffected, and on Node
  20.19+/22+ `require()` of the ESM entry keeps working via `require(esm)`.

### Minor Changes

- Production-hardening pass:

  - `handler.check` now receives an `AbortSignal` (a purely additive parameter — existing
    single-argument handlers keep working unmodified), aborted when `stop()` is called while
    that particular check is in flight.
  - `PendingTaskHandler.retryBackoffMs(failureCount)` — optional backoff for the failure-retry
    cadence specifically, separate from the normal `pollIntervalMs`.
  - `PendingTaskPollerOptions.onLeaderChange`/`onTick` — optional observability hooks for
    leadership-status flips and per-tick duration/task-count.
  - `CreatePendingTaskStoreOptions.taskListWarnThreshold` — one-time `console.warn` if the
    tracked task count crosses a threshold (default 200), flagging the localStorage-quota risk
    of a very large task list.
  - Added a Playwright suite (`test-e2e/`) that verifies cross-tab poll-leader election and the
    result relay against a real browser (real `navigator.locks`, real `storage` events) rather
    than only jsdom's unlocked fallback path.
  - Packaging: added `LICENSE` and npm metadata (`license`/`author`/`repository`/`homepage`/
    `bugs`/`keywords`), a `prepublishOnly` guard, `oxlint`, CI (GitHub Actions), and Changesets
    for versioning.

### Patch Changes

- Widened the `react` peer dependency from `>=19` to `>=18` — the hook only uses
  `useEffect`/`useRef`, so React 18 works as-is.
- Storage-disabled browsers (cookies/site data turned off, where the `localStorage` accessor
  itself throws a `SecurityError`) no longer break the engine: persisted-task reads now go
  through the same guarded storage path as writes, and a throwing store write can no longer
  wedge the poller's tick loop permanently (`isChecking` is always reset).
