# pending-task-kit

Framework-agnostic engine for tracking and polling long-running background tasks
(AI generation jobs, async search, payment confirmation, batch operations, ...)
that can outlive the page that started them, plus an optional React binding.

Extracted from a production app's `PendingTaskNotifier` subsystem. The
notification channel (toasts, redirects, cache invalidation) is deliberately
**not** part of this package — you wire that up yourself via `onResult`.

## Install

```bash
pnpm add pending-task-kit zustand
# React binding also needs react as a peer dep (already true in a React app)
```

## Core concepts

- **Task** (`PendingTask`) — `{ id, type, taskId, startedAt, ttlMs?, metadata? }`, one row
  tracked until it resolves or expires. There are no dedicated "owner"/"title"/"link" fields
  — the engine reads nothing off a task except `id`/`type`/`taskId`/`startedAt`/
  `lastCheckedAt`/`failureCount`/`ttlMs` (the last two it maintains itself, as dedicated
  fields precisely so they can't collide with a key your own data happens to use). Anything
  else your app wants attached to a task — a display title, a link, a user/tenant id to scope
  by — goes in the fully free-form `metadata`; filter on it with the store's `pruneTasksBy`.
- **Handler** (`PendingTaskHandler`) — per `type`, defines `check(task, signal)` that polls
  your backend and returns `{ status: "pending" | "success" | "failure", progress?, data? }`
  — `data` is a free-form payload (a link, a message, whatever your `onResult` needs; see
  below), plus per-type tuning (`pollIntervalMs`, `ttlMs`, `finalCheckOnExpiry`,
  `silentOnSuccess`/`silentOnFailure`, `retryBackoffMs` — see "Cancellation and retry
  backoff" below). `signal` is an `AbortSignal` you can ignore entirely (existing handlers
  that only take `task` keep working unmodified) or wire into your own request.
- **Registry** (`PendingTaskRegistry`) — a plain `{ [type]: handler }` map.
- **Store** — a zustand store, persisted to `localStorage`, holding the task list. Warns
  once (`console.warn`) if the tracked task count crosses `taskListWarnThreshold` (default 200) — the whole list is one JSON blob rewritten on every change, so a very large list
  risks the ~5MB per-origin quota.
- **Poller** (`PendingTaskPoller`) — the engine: scans tasks on an interval, calls the
  matching handler, and resolves each task to `success`/`failure` (dispatched via
  `onResult`), to `error` (dispatched unless `silentOnFailure`) when `check()` itself kept
  throwing until `maxFailureCount`, or silently to `expired` when the TTL ran out first —
  `error`/`expired` are the engine's own doing, never something a handler returns itself.

## Usage (core, no React)

```ts
import { createPendingTaskStore, createPendingTaskRegistryBinding, PendingTaskPoller } from "pending-task-kit"

type TaskType = "search" | "exportJob"

const store = createPendingTaskStore<TaskType>({ storageKey: "my-app-pending-tasks" })

const registry = {
  search: {
    // The engine has no notion of auth — check() is a plain closure, so it captures
    // whatever auth your app uses (a token, a cookie-based fetch, etc.) itself.
    check: async (task) => {
      const token = myAuthStore.getState().token
      const res = await fetch(`/api/search/${task.taskId}`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      // The backend's own `data.status` vocabulary is whatever that API defines — it has no
      // relationship to the status you return here.
      if (data.status === "done") return { status: "success", data: { href: `/results/${task.taskId}` } }
      if (data.status === "error") return { status: "failure", data: { message: data.error } }
      return { status: "pending", progress: { percent: data.percent } }
    },
    pollIntervalMs: 3_000,
    ttlMs: 5 * 60_000,
  },
}

const { addTask, addTaskIfMissing } = createPendingTaskRegistryBinding(store, registry)

// Start tracking a task right after kicking off the async job. If tasks need to be scoped
// to the signed-in user/tenant, put that in `metadata` — see "Scoping tasks" below.
addTask({
  id: `search-${searchId}`,
  type: "search",
  taskId: searchId,
  startedAt: Date.now(),
  metadata: { userId },
})

// Drive the polling loop (module-level singleton). Call start()/stop() around your own
// auth lifecycle — e.g. start() once logged in, stop() on logout.
const poller = new PendingTaskPoller({
  store,
  registry,
  onResult: (detail) => {
    const data = detail.data as { href?: string; message?: string } | undefined
    if (detail.status === "success") showToast(data?.message ?? "Done", { href: data?.href })
    if (detail.status === "failure") showToast(data?.message ?? "Failed", { variant: "error" })
    // detail.status can also be "error" (check() itself kept failing) — decide separately
    // whether that deserves its own message; "expired" never reaches onResult at all.
  },
  onCheckError: (error) => {
    // Return true for an error that means "stop this tick, don't count it as a normal
    // failure" — e.g. the session ended. The engine doesn't know what an auth error looks
    // like; you decide.
    if (isUnauthorizedError(error)) {
      poller.stop()
      return true
    }
  },
})
poller.start()
```

## Usage (React binding)

```tsx
import { usePendingTaskPoller } from "pending-task-kit/react"

function PendingTaskNotifier() {
  const token = useAuthStore((s) => s.token)

  usePendingTaskPoller({
    store,
    registry,
    enabled: !!token, // the hook has no notion of auth — you decide when polling should run
    onResult: (detail) => {
      /* show a toast / navigate / invalidate a query cache */
    },
  })

  return null
}
```

Mount `<PendingTaskNotifier />` once near your app root.

## Cancellation, retry backoff, and observability (all optional)

`stop()` aborts the `AbortSignal` passed to whichever `handler.check()` call is currently in
flight, if any — wire it into your own request (`fetch(url, { signal })`) if you want a
stopped poller to actually cancel outstanding network work instead of only discarding the
response once it arrives. Losing leadership to another tab is only ever discovered _after_
`check()` has already settled, so that's the only thing that ever aborts it; handlers that
ignore `signal` keep working exactly as before.

A `check()` that keeps throwing retries on the same fixed `pollIntervalMs`/
`defaultPollIntervalMs` cadence as everything else by default — set a handler's
`retryBackoffMs(failureCount)` to back off instead, once a task has actually failed at least
once:

```ts
const registry = {
  search: {
    check: async (task, signal) => {
      /* ... */
    },
    retryBackoffMs: (failureCount) => Math.min(1_000 * 2 ** failureCount, 60_000), // capped exponential
  },
}
```

`onLeaderChange(isLeader)` fires when this tab's own belief about holding poll leadership
flips (not once per tick), and `onTick({ durationMs, taskCount })` fires at the end of every
tick that actually ran — both purely observational, for wiring into your own metrics/logging:

```ts
const poller = new PendingTaskPoller({
  store,
  registry,
  onLeaderChange: (isLeader) => metrics.gauge("pending_task_poller.is_leader", isLeader ? 1 : 0),
  onTick: ({ durationMs, taskCount }) => metrics.histogram("pending_task_poller.tick_ms", durationMs),
})
```

Every diagnostic warning this package emits (an oversized task list, an invalid
`pollLeaseTtlMs`, a task whose `type` has no registered handler, a second poller started on
the same store in the same tab) goes to `console.warn` by default — pass a `logger`
(`PendingTaskLogger`, a `{ warn(message) }` object) to `createPendingTaskStore` or
`PendingTaskPoller` to route those into your own telemetry/logging instead:

```ts
const poller = new PendingTaskPoller({
  store,
  registry,
  logger: { warn: (message) => myTelemetry.warn(message) },
})
```

## Cross-tab poll-leader election (on by default)

When multiple tabs share the same store — they already do, since tasks sync across tabs via
`storage` events — only one of them actually calls `handler.check()` for a given task at a
time; every other tab skips its own network work for that task entirely. This is
`crossTabPollLeaderElection`, on by default. It's safe to leave on for single-tab usage too:
an uncontested poller always successfully claims/renews its own lease, so nothing changes when
there's no other tab to contend with.

Leadership is a renewable, TTL-backed claim (`pollLeaseTtlMs`, default `pollTickMs * 4`), not
a held lock — a leader that stops renewing (closed, crashed, or frozen in the browser's
back/forward cache) can't block every other tab forever; the lease just expires and any other
open tab picks up leadership on its next tick. `stop()` also makes a best-effort attempt to
release the lease right away if held (fire-and-forget, since `stop()` itself is synchronous —
an abrupt page unload can still lose the race), so a graceful shutdown usually doesn't make
other tabs wait out the full TTL either.

Since only the leader ever detects a task's completion, its result is relayed to every other
tab through a second localStorage key (`resultRelayKey`, default
`` `${storageKey}-result-relay` ``): each other tab fires its own `onResult` and (if that tab
also has `dispatchDomEvent` on) its own `CustomEvent`, from the relayed data, the same as if it
had detected the completion itself. If you've composed `claimResultOnce` (see the next
section), the relayed dispatch on every other tab goes through that same gate as the leader's
own local one — combining both gets you "only the leader polls" _and_ "at most one tab ends up
notifying," consistently, regardless of which tab happened to detect the result.

Only one `PendingTaskPoller` instance should exist per tab per store — a `storage` event never
fires back in the tab that made the write, so a second poller instance sharing the same store
in the _same_ tab would never receive this relay (or the task-list sync above) at all. Starting
a second one while the first is still running warns once at runtime (via `logger` — see
"Cancellation, retry backoff, and observability" above).

If a relayed result could belong to a session that's ended in _this_ tab by the time it
arrives (a different account signed in, a logout) and re-surfacing it here would be wrong,
gate the receiving side with `acceptRelayedResult`:

```ts
const poller = new PendingTaskPoller({
  store,
  registry,
  acceptRelayedResult: (detail) => detail.task.metadata?.userId === myAuthStore.getState().userId,
})
```

Turn cross-tab leader election off entirely only if you have a specific reason every tab must
independently poll everything:

```ts
const poller = new PendingTaskPoller({
  store,
  registry,
  crossTabPollLeaderElection: false,
})
```

## Cross-tab duplicate-toast dedupe (optional)

`crossTabPollLeaderElection` above stops tabs from duplicating the _polling_ itself, and a
fencing check keeps a slow `check()` call from letting a _different_ tab also reach `finalize()`
for the same task after leadership has moved on mid-request. It doesn't guarantee `onResult`
fires exactly once system-wide on its own, though — narrower windows remain: your own
`claimResultOnce` callback awaiting something slow can itself let leadership move to another tab
before it resolves, which then independently completes the same task and calls its own
`claimResultOnce`; `withTabLock` degrades to no mutual exclusion at all in a browser without the
Web Locks API; and a lease write that silently fails (quota exceeded, private-mode Safari) can,
rarely, let two tabs both believe they're leader. If several tabs can end up processing the same
completion (any of those, or a forced re-login race), compose the included primitives via
`claimResultOnce` — this also gates the _relayed_ dispatch on every other tab (see above), so it
gives you a true system-wide guarantee even with leader election on:

```ts
import { withTabLock, createTtlDedupeCache } from "pending-task-kit"

const notified = createTtlDedupeCache("my-app-pending-task-notified", 24 * 60 * 60 * 1000)

const poller = new PendingTaskPoller({
  // ...
  claimResultOnce: (task) => withTabLock(`pending-task:${task.id}`, () => notified.claim(`${task.id}:${task.startedAt}`)),
})
```

Key the claim on `` `${task.id}:${task.startedAt}` ``, not on `task.id` alone. `id` is
documented as "stable, globally-unique — re-adding a task with the same id replaces it" (see
the `PendingTask.id` doc comment), so the _same_ id can legitimately front several independent
runs over time (e.g. a user re-triggering the same paid action twice in one day). A cache
keyed on bare `task.id` doesn't distinguish those runs: the TTL window has to outlive one
run's own lifetime — a second tab can legitimately reach the same completion late (a slow
`claimResultOnce` await, a frozen tab waking up, an expiry-time `finalCheckOnExpiry`), so the
record must still be there when it does — which means it also spans across a second, unrelated
run's completion: that second completion's `onResult`/relayed dispatch gets silently swallowed
as if it were a duplicate of the first. `startedAt` is written fresh each time a _new_ run is
added (see the `addTask` doc comment's replace-on-same-id note), while two tabs racing over
the _same_ run still see the same `startedAt` — so appending it narrows the dedupe to "this
run" without reopening the cross-tab race this section exists to close.

If whatever `claimResultOnce` gates on (or `metadata`/`data` fields in the tasks it tracks) can
carry PII, call `notified.clear()` on explicit logout the same way you'd call the store's
`clearAllTasks()` — see "Scoping tasks" below.

## Scoping tasks (e.g. to a user/tenant)

`PendingTask` has no dedicated "owner" field — the engine doesn't know or care what a task
"belongs to". If your app needs that (most do), put an identifier of your choosing in
`metadata` when you `addTask`, and use the store's `pruneTasksBy(predicate)` to drop tasks
that don't match it — e.g. after a different account logs in:

```ts
store.getState().pruneTasksBy((task) => task.metadata?.userId === currentUserId)
```

This package also has no opinion on login/logout more broadly — call `pruneTasksBy` after
login and `clearAllTasks()` on explicit logout yourself, in whatever auth store you use.
Skipping `clearAllTasks()` on a _forced_ (e.g. 401) logout lets in-flight tasks (like a pending
payment confirmation) survive a quick re-login — that's an intentional choice to make, not a
default this package bakes in.

If a task's `metadata` or a handler's `PendingTaskCheckResult.data` can carry PII, remember
this can now also transiently sit in the `resultRelayKey` localStorage entry (see "Cross-tab
poll-leader election" above) once `crossTabPollLeaderElection` is on — it's overwritten by the
next result, but nothing clears it proactively. Clear it on explicit logout the same way you'd
call the store's `clearAllTasks()` or a dedupe cache's `clear()`:

```ts
import { clearResultRelay } from "pending-task-kit"

clearResultRelay(resultRelayKey) // same key you passed, or `${storageKey}-result-relay`
```

## Runtime environment notes

A grab-bag of behaviors that are intentional trade-offs rather than bugs, collected here so
they're documented somewhere instead of only in source comments:

- **Wall-clock dependent** (`Date.now()` throughout). A clock stepping _backward_ just delays
  polling/lease-renewal/dedupe harmlessly. A clock jumping _forward_ can make a batch of tasks
  expire silently all at once and make leases/dedupe records expire early — fencing (see
  "Cross-tab poll-leader election") still keeps leadership _correct_ through that, just less
  available for a moment.
- **Leadership rotates routinely, even in foreground tabs.** The lease's TTL defaults to 8s
  (`pollTickMs` × 4), and it's only _renewed_ by ticks that actually have a due task to check
  — so with the default 10s `pollIntervalMs` the lease expires between checks anyway and the
  next due tick re-contends for it, in whichever tab gets there first. Backgrounded tabs make
  this much more pronounced: Chrome (and others) throttle a backgrounded tab's timers down to
  as infrequently as once a minute, so a backgrounded leader readily loses leadership to
  another (possibly also backgrounded) tab, and two backgrounded tabs can end up trading
  leadership back and forth. Correctness is unaffected (Web Locks serialize the handoff,
  fencing catches any stale response) — it's purely a responsiveness/battery trade-off already
  inherent to how browsers treat inactive tabs.
- **`stop()` doesn't hook `pagehide`/`beforeunload` for you.** A hard page unload (closing the
  tab, navigating away) leaves that tick's in-memory batch unflushed and this tab's lease to
  expire on its own TTL (default 8s) rather than being released immediately — the same
  "closed/crashed/frozen tab" case `pollLeaseTtlMs` is already designed to bound.
- **The React binding's tab-refocus recovery has no non-React equivalent.**
  `usePendingTaskPoller` calls `forceCheckAll()` on `visibilitychange`; if you're using the core
  API directly, wire that up yourself if you want the same "don't sit stale after tabbing back
  in" behavior.
- **A consumer callback that throws becomes an uncaught exception**, deliberately — surfaced on
  a fresh microtask rather than silently swallowed or left as an unhandled rejection, so a bug
  in your own `onResult`/`onCheckError`/etc. is as visible as any other uncaught error in your
  app, not hidden inside this package.
- **`zustand`'s own `persist` middleware logs its own `console.warn` on a storage failure** (SSR,
  storage fully unavailable) — that noise comes from zustand itself, not from this package,
  which otherwise degrades storage failures quietly (see `hasUnpersistedWrites`).
- **A task whose `type` doesn't match any registry entry** (typo'd, or a handler that was
  removed/renamed after the task was created) sits until its TTL expires — the poller warns
  once per such `type` (via `logger`, defaulting to `console`) so it isn't silent, but nothing
  recovers the task itself. Parameterize `TType` with a literal string union (rather than
  leaving it as plain `string`) to get exhaustiveness checking on your own registry instead.
- **The Playwright suite (`test-e2e/`) only runs against Chromium** — Safari/WebKit's
  `navigator.locks` implementation is a known area where behavior could differ; add a WebKit
  project to `playwright.config.ts` if that matters for your users.
- **This package is pre-1.0.** Per semver convention for `0.x`, a `minor` bump _may_ include a
  breaking change — 0.2.0 already exercises that by dropping the CommonJS build (see
  `CHANGELOG.md`), and future `0.x` releases make no stability guarantee either.

## What's deliberately out of scope

- Toast/notification UI (`onResult` is a plain callback — bring your own).
- Navigation, messages, action labels, cache invalidation — `PendingTaskCheckResult.data`
  is a free-form payload for all of it; `status` is the only field the engine itself reads.
- Auth/session management entirely — there's no token concept anywhere in the engine.
  `handler.check(task)` is a plain closure, so it captures whatever auth your app uses itself;
  `start()`/`stop()` (or the React binding's `enabled`) are how you gate polling on being
  logged in; `onCheckError` lets you recognize an auth failure and react to it (e.g. call
  `stop()`) without the engine knowing what "unauthorized" means.

## Contributing

Development requires Node 24+ (see `engines` in `package.json`; the library itself is a
browser runtime with no Node dependency — this is purely about the toolchain).

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` should all pass; `pnpm test:e2e` runs
a small real-Chromium Playwright suite (`test-e2e/`) that specifically exercises cross-tab
`navigator.locks` arbitration and genuine `storage` events — the one thing the jsdom-based
`pnpm test` suite structurally can't do.

This package uses [Changesets](https://github.com/changesets/changesets) for versioning.
Every change that should land in a release needs a changeset: run `pnpm changeset`, describe
the change, and pick `patch`/`minor`/`major` — commit the generated file in `.changeset/`
alongside your change. CI's `changeset status --since` check fails a PR that changed something
without one, so this isn't just a convention. The check doesn't look at file types, so a
docs/CI/test-only PR trips it too — `pnpm changeset --empty` is the sanctioned escape hatch
for those (commit the empty changeset it generates).

Releases are tag-triggered (`.github/workflows/release.yml`), not merge-triggered: run
`pnpm changeset version` (bumps `package.json` and updates `CHANGELOG.md`), commit that, tag the
commit `vX.Y.Z` matching the version it just bumped to, and push the tag. The release job then
does a clean checkout of exactly that tag, rebuilds and re-verifies everything from scratch, and
publishes with `--provenance` — so what gets published is always traceable to a tagged, reviewed
commit, never to whatever happened to be sitting in a working tree. Needs an `NPM_TOKEN` repo
secret with publish access.
