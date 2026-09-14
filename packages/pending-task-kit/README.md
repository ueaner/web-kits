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
- **Handler** (`PendingTaskHandler`) — per `type`, defines `check(task)` that polls your
  backend and returns `{ status: "pending" | "success" | "failure", progress?, data? }` —
  `data` is a free-form payload (a link, a message, whatever your `onResult` needs; see
  below), plus per-type tuning (`pollIntervalMs`, `ttlMs`, `finalCheckOnExpiry`,
  `silentOnSuccess`/`silentOnFailure`).
- **Registry** (`PendingTaskRegistry`) — a plain `{ [type]: handler }` map.
- **Store** — a zustand store, persisted to `localStorage`, holding the task list.
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

## Cross-tab duplicate-toast dedupe (optional)

If several tabs can end up processing the same task's completion (e.g. after a
forced re-login race), compose the included primitives via `claimResultOnce`:

```ts
import { withTabLock, createTtlDedupeCache } from "pending-task-kit"

const notified = createTtlDedupeCache("my-app-pending-task-notified", 24 * 60 * 60 * 1000)

const poller = new PendingTaskPoller({
  // ...
  claimResultOnce: (task) => withTabLock(`pending-task:${task.id}`, () => notified.claim(task.id)),
})
```

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
Skipping `clearAllTasks()` on a *forced* (e.g. 401) logout lets in-flight tasks (like a pending
payment confirmation) survive a quick re-login — that's an intentional choice to make, not a
default this package bakes in.

## What's deliberately out of scope

- Toast/notification UI (`onResult` is a plain callback — bring your own).
- Navigation, messages, action labels, cache invalidation — `PendingTaskCheckResult.data`
  is a free-form payload for all of it; `status` is the only field the engine itself reads.
- Auth/session management entirely — there's no token concept anywhere in the engine.
  `handler.check(task)` is a plain closure, so it captures whatever auth your app uses itself;
  `start()`/`stop()` (or the React binding's `enabled`) are how you gate polling on being
  logged in; `onCheckError` lets you recognize an auth failure and react to it (e.g. call
  `stop()`) without the engine knowing what "unauthorized" means.
