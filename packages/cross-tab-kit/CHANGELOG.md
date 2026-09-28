# cross-tab-kit

## 0.4.1

### Patch Changes

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

- e730427: `exports` 中的运行时分支配 `"default"` 改为 `"import"`（仅 CTK、PTK；CSC 原本就是 `"import"`，无需改动）。

  行为差异：

  - **ESM 消费者（Node ESM、bundler、Vitest）：完全不变**。Node 在 ESM 路径下会优先匹配 `"import"` 条件；之前 `"default"` 作为唯一条件时也是被这条路径命中，所以运行时行为一致。
  - **CJS 消费者：现在会显式失败**（`ERR_PACKAGE_PATH_NOT_EXPORTED`），而不是含糊地拿到 ESM 文件后被 Node 22.12+ 的 `require(esm)` 静默加载。这与三个包 `"type": "module"` 的 ESM-only 立场一致。

  API 与类型没有任何变化。`publint` 三包全绿。

## 0.4.0

### Minor Changes

- a27fa88: Export `SHORT_TTL_WARN_MS` and `SLOW_WAIT_WARN_MS` (the previously-private thresholds behind `createLeadershipGate`'s two diagnostic warnings), and add `linkAbortSignal(source, target)` — the "abort `target`, propagating `source`'s reason, once `source` aborts (or immediately if it's already aborted); returns an unlink function" wiring that `TabLockContext.timeoutSignal`/`Tenure.signal`/`LeadershipContext.signal` are all meant to be composed with, extracted from `withTabLock`'s own internal signal-merging (which now uses it too — no behavior change there).

  No existing API changed; this only adds new named exports to the main entry.

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
