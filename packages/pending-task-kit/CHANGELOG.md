# pending-task-kit

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
