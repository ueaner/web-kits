# pending-task-kit

## 0.6.0

### Minor Changes

- e730427: 构建目标统一为 ES2022（`tsconfig.base.json` 的 `target`/`lib`，并显式声明
  `useDefineForClassFields: true`，避免将来下调 `target` 时类字段语义被静默改变）。

  对三个包的影响并不相同：

  - **`cross-tab-kit` / `cross-sqlite-client`：发布产物逐字节不变**，仅构建配置变化。
  - **`pending-task-kit`：`dist` 有实际变化**。ES2022 下 TS/oxc 直接输出**原生 class field**
    （`PendingTaskPoller` 的字段声明），并把这些字段上的 doc 注释作为普通注释保留下来：
    `dist` 体积从 27.10 kB 增至 29.45 kB。因此发布包的**最低 JS 引擎要求随之抬到 ES2022**
    （原生 class fields ≈ Chrome 74+ / Safari 14.1+ / Firefox 69+）。

  API 与运行时行为没有任何变化，但浏览器兼容基线变了，所以 `pending-task-kit` 记 `minor`。
  如果你的目标浏览器低于上面的基线、且构建流程不会对 `node_modules` 里的依赖做降级，
  请在打包阶段自行降级该依赖（或在 issue 里说明，我们可以为它单独设一个更低的 `target`）。

### Patch Changes

- e730427: `exports` 中的运行时分支配 `"default"` 改为 `"import"`（仅 CTK、PTK；CSC 原本就是 `"import"`，无需改动）。

  行为差异：

  - **ESM 消费者（Node ESM、bundler、Vitest）：完全不变**。Node 在 ESM 路径下会优先匹配 `"import"` 条件；之前 `"default"` 作为唯一条件时也是被这条路径命中，所以运行时行为一致。
  - **CJS 消费者：现在会显式失败**（`ERR_PACKAGE_PATH_NOT_EXPORTED`），而不是含糊地拿到 ESM 文件后被 Node 22.12+ 的 `require(esm)` 静默加载。这与三个包 `"type": "module"` 的 ESM-only 立场一致。

  API 与类型没有任何变化。`publint` 三包全绿。

- Updated dependencies [e730427]
- Updated dependencies [e730427]
  - cross-tab-kit@0.4.1

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
