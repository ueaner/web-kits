# pending-task-kit

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
