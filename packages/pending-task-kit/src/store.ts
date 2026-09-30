import { safeGetItem, safeSetItem } from "cross-tab-kit/advanced"
import { rethrowAsync } from "./rethrow"
import type { PendingTask, PendingTaskLogger } from "./types"

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_STORAGE_KEY = "pending-tasks"
/** Default for `CreatePendingTaskStoreOptions.taskListWarnThreshold` — see its doc comment. */
export const DEFAULT_TASK_LIST_WARN_THRESHOLD = 200

/** Version stamped on the persisted entry. The on-disk shape — `{ state: { tasks }, version }` —
 *  is the one zustand's `persist` middleware wrote for 0.6.0 and earlier (this store was a
 *  zustand store until 0.7.0), kept byte-compatible so upgrading never loses a user's tasks:
 *  entries written by older versions (`version: 0` before 0.3.0, `version: 1` since, or no
 *  `version` at all) all hydrate as-is. Bump this and add a real migration in
 *  `parseTasksFromStorageValue` only when the shape itself actually changes. */
const PERSIST_VERSION = 1

export interface PendingTaskStoreState<TType extends string = string> {
  tasks: PendingTask<TType>[]
  addTask: (task: PendingTask<TType>) => void
  removeTask: (id: string) => void
  updateTask: (id: string, patch: Partial<PendingTask<TType>>) => void
  /** Removes every task for which `predicate` returns false — e.g. drop tasks that don't
   *  belong to the account now signed in, however your app identifies "belongs to". */
  pruneTasksBy: (predicate: (task: PendingTask<TType>) => boolean) => void
  clearAllTasks: () => void
}

export type PendingTaskStoreListener<TType extends string = string> = (
  state: PendingTaskStoreState<TType>,
  previousState: PendingTaskStoreState<TType>,
) => void

export interface PendingTaskStore<TType extends string = string> {
  /** The current snapshot: `tasks` plus the mutators. A new object on every write (the
   *  mutators themselves stay the same functions), so identity comparison detects a change. */
  getState: () => PendingTaskStoreState<TType>
  /**
   * Calls `listener` after every change — a write in this tab, or another tab's write to the
   * same `storageKey` — with the new snapshot and the one this listener last received (the
   * snapshot current when it subscribed, for its first call). Returns an unsubscribe function;
   * each `subscribe` call is its own subscription, even for the same function.
   *
   * - While the store has at least one subscriber it listens for other tabs' writes (the
   *   browser's `storage` event) and adopts them — so a `usePendingTasks` component or a running
   *   `PendingTaskPoller` keeps it in sync. With no subscribers, `getState().tasks` isn't kept
   *   current (the mutators always re-read storage regardless); the first new subscriber
   *   re-syncs it.
   * - A listener that writes again from inside its callback: the newer snapshot is delivered to
   *   everyone, and the older one to no one who hadn't received it yet — each listener's
   *   `previousState` is still the last snapshot *it* saw, so diffing the pair never skips a
   *   change.
   * - A listener unsubscribed mid-notification (by itself or another) isn't called again.
   * - A throwing listener is rethrown on a fresh microtask, without affecting the write or the
   *   other listeners.
   *
   * Framework bindings build on this — see `usePendingTasks` in `pending-task-kit/react`.
   */
  subscribe: (listener: PendingTaskStoreListener<TType>) => () => void
  storageKey: string
  /**
   * True when the most recent write to this store's localStorage entry threw (quota exceeded,
   * Safari private browsing, storage disabled, ...) instead of landing — by whichever writer
   * made it: this store's own mutators, or an external batched write via `writeTasks` (e.g.
   * `PendingTaskPoller`'s `flushBatch`). While true, persisted storage
   * no longer reflects this tab's in-memory state, so anything about to rebuild `tasks` from a
   * freshly-read persisted snapshot should build on `getState().tasks` instead, and anything
   * checking "does another tab already have this task" (e.g. `addTaskIfMissing`) should not
   * trust a persisted-storage read either. Flips back to `false` as soon as a write through
   * this store's own mutators or `writeTasks` succeeds again, or when another tab's write is
   * adopted (memory then mirrors storage again).
   *
   * This is the single shared source of truth for that fact — treat it as read-only from
   * outside this module; it's written only by this store itself.
   */
  hasUnpersistedWrites: boolean
  /**
   * Writes `tasks` to this store the same way its own mutators do, through the single shared
   * safe-write path that also updates `hasUnpersistedWrites`. Anything outside this module that
   * replaces the whole `tasks` array wholesale (currently `PendingTaskPoller`'s batched
   * `flushBatch` writes) must go through this — so its own write failures are visible to this
   * store's mutators (and vice versa) instead of the two silently drifting out of sync about
   * whether persisted storage can currently be trusted. (Other tabs' writes need no call here:
   * the store adopts them itself while subscribed — see `subscribe`.)
   */
  writeTasks: (tasks: PendingTask<TType>[]) => void
}

export interface CreatePendingTaskStoreOptions {
  /** localStorage key. Defaults to `"pending-tasks"`. Must be unique per app if you run multiple stores. */
  storageKey?: string
  /**
   * Soft warning threshold for the tracked task count, checked on every write. The whole list
   * is persisted as a single JSON blob on every change — a very large list risks the ~5MB
   * per-origin localStorage quota and makes every write (and every other tab's `storage`-event
   * re-parse) slower, but nothing previously surfaced that risk until it actually broke. Once
   * the count crosses this threshold, warns exactly once for this store's lifetime
   * (never again after, even if the count keeps climbing) — not a hard limit, tasks keep being
   * tracked normally either way. Defaults to `DEFAULT_TASK_LIST_WARN_THRESHOLD` (200); set to
   * `Infinity` to disable if your app genuinely needs to track more.
   */
  taskListWarnThreshold?: number
  /** Diagnostic-warning channel for this store (currently just the `taskListWarnThreshold`
   *  warning). Defaults to `console` — see `PendingTaskLogger`. */
  logger?: PendingTaskLogger
}

export function isPendingTaskShape(value: unknown): value is PendingTask {
  if (!value || typeof value !== "object") return false
  const t = value as Record<string, unknown>
  return (
    typeof t.id === "string" &&
    typeof t.type === "string" &&
    typeof t.startedAt === "number" &&
    (typeof t.taskId === "number" || typeof t.taskId === "string")
  )
}

/** Parses the raw string this store's localStorage entry holds (see `PERSIST_VERSION` for the
 *  shape), tolerating garbage/foreign values. Any `version` is accepted as-is — the shape has
 *  never changed. */
export function parseTasksFromStorageValue<TType extends string = string>(value: string | null): PendingTask<TType>[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    const tasks = (parsed as { state?: { tasks?: unknown } } | null)?.state?.tasks
    if (!Array.isArray(tasks)) return []
    return tasks.filter(isPendingTaskShape) as PendingTask<TType>[]
  } catch {
    return []
  }
}

/** Reads a store's persisted tasks directly from localStorage, bypassing its in-memory
 *  snapshot — useful right before a cross-tab existence check, since the in-memory state
 *  in this tab may not yet reflect a write another tab just made.
 *
 *  Goes through `safeGetItem` rather than reading `localStorage` directly: a browser with
 *  site data/storage fully disabled can make even `typeof localStorage` itself throw a
 *  SecurityError (see the doc comment on `safeGetItem` in `cross-tab-kit`) — reading it
 *  unguarded here would propagate straight out of every store mutator, `addTaskIfMissing`, and
 *  `flushBatch`, in a package that otherwise degrades every other localStorage access safely. */
export function readPersistedTasks<TType extends string = string>(storageKey: string): PendingTask<TType>[] {
  return parseTasksFromStorageValue<TType>(safeGetItem(storageKey))
}

/**
 * Creates an isolated pending-task store. Each store persists to its own localStorage key,
 * so most apps should create exactly one instance and share it (module-level singleton).
 *
 * Every mutator re-reads the persisted value before writing, rather than trusting the
 * in-memory snapshot — this avoids resurrecting a task another tab already removed.
 */
export function createPendingTaskStore<TType extends string = string>(
  options: CreatePendingTaskStoreOptions = {},
): PendingTaskStore<TType> {
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
  // NaN is guarded against explicitly (falls back to the default) because `length >
  // taskListWarnThreshold` is silently always false when the threshold is NaN — the same
  // *effect* as the documented `Infinity` disable value, but unlike `Infinity` this one was
  // never intended to mean "disabled" and is easy to produce by accident (e.g. a mistyped env
  // var parsed with `Number(...)`).
  const taskListWarnThreshold =
    options.taskListWarnThreshold === undefined || Number.isNaN(options.taskListWarnThreshold)
      ? DEFAULT_TASK_LIST_WARN_THRESHOLD
      : options.taskListWarnThreshold
  const logger: PendingTaskLogger = options.logger ?? console
  const readPersisted = (): PendingTask<TType>[] => readPersistedTasks<TType>(storageKey)

  // Fires at most once per store instance — see `taskListWarnThreshold`'s doc comment.
  let hasWarnedAboutTaskListSize = false

  const warnIfTaskListTooLarge = (length: number): void => {
    if (hasWarnedAboutTaskListSize || length <= taskListWarnThreshold) return
    hasWarnedAboutTaskListSize = true
    try {
      // Wrapped in its own try/catch: a logger whose `warn` itself throws (or a `console`
      // that's missing entirely) must not prevent the actual task-list write that follows this.
      logger.warn(
        `pending-task-kit: tracking ${length} tasks for storageKey "${storageKey}", past the ` +
          `soft warning threshold of ${taskListWarnThreshold}. The whole list is persisted as a ` +
          "single localStorage entry on every change — a very large list risks the ~5MB per-origin " +
          "quota and slows down every write. Consider pruning stale tasks more aggressively (see " +
          "pruneTasksBy), or pass a higher taskListWarnThreshold if this app genuinely needs to track " +
          "this many.",
      )
    } catch {
      // See the comment above — degrade silently rather than let a broken logger take down a
      // write.
    }
  }

  let state: PendingTaskStoreState<TType>
  /** One record per `subscribe` call; `lastState` is what that subscriber last received. */
  interface Subscription {
    listener: PendingTaskStoreListener<TType>
    lastState: PendingTaskStoreState<TType>
  }
  const subscriptions = new Set<Subscription>()
  /** The raw persisted value memory was last known to match — what this store last wrote, or
   *  last read. Lets `syncFromStorage` skip an unchanged value instead of replacing every task
   *  with an equal-but-new object (which would needlessly re-render every subscriber). */
  let lastKnownRaw: string | null = null

  // Applies a new task list in memory and notifies subscribers. Shared by both kinds of change:
  // this tab's writes (`writeTasks`, which persists first) and other tabs' writes adopted from
  // storage (`syncFromStorage`, which must not persist — see there).
  const commit = (tasks: PendingTask<TType>[]): void => {
    const nextState: PendingTaskStoreState<TType> = { ...state, tasks }
    state = nextState
    // Iterate a snapshot so a subscription added mid-notification doesn't get this change (it
    // subscribed after it, and starts from `state` already), but re-check membership so one
    // removed mid-notification isn't called after it unsubscribed. A throwing listener is
    // consumer code, surfaced the same way as every other consumer callback in this package —
    // it must neither abort the change that triggered it (possibly `PendingTaskPoller`'s
    // batched flush) nor starve the listeners after it.
    for (const subscription of Array.from(subscriptions)) {
      // A listener that wrote again re-entrantly has already delivered that newer snapshot to
      // every subscriber (each with its own `lastState` as `previousState`, so no change is
      // lost from a diff) — delivering this now-stale one afterwards would leave them ending on
      // an outdated snapshot, so the newest change wins and this one stops here.
      if (state !== nextState) break
      if (!subscriptions.has(subscription)) continue
      const previousState = subscription.lastState
      subscription.lastState = nextState
      try {
        subscription.listener(nextState, previousState)
      } catch (error) {
        rethrowAsync(error)
      }
    }
  }

  // Persists synchronously on every write, and a failed write (quota exceeded, Safari private
  // browsing, storage disabled or absent entirely) degrades persistence to this-tab-only rather
  // than throwing out of whichever caller triggered it: the in-memory state is applied either
  // way (same treatment `createTtlDedupeCache` gives this failure mode). This is the only
  // writer of `hasUnpersistedWrites` besides `syncFromStorage` — this store's own mutators and
  // `writeTasks` (the external entry point `PendingTaskPoller` uses for its batched writes)
  // both route through it, so a write failure on either path is visible to both instead of each
  // tracking its own disconnected flag. Also the single choke point every task-list mutation
  // passes through, which is why the size warning check runs here too (the initial load and
  // storage sync are the paths that don't go through this, and check separately).
  const writeTasks = (tasks: PendingTask<TType>[]): void => {
    warnIfTaskListTooLarge(tasks.length)
    let serialized: string | undefined
    try {
      serialized = JSON.stringify({ state: { tasks }, version: PERSIST_VERSION })
    } catch {
      // `metadata` is free-form (and `check()` progress is merged into it), so a BigInt or a
      // circular reference in it makes the list unserializable — the same "persistence
      // degrades to this-tab-only" outcome as a failed write, not a crash in the caller.
    }
    const persisted = serialized !== undefined && safeSetItem(storageKey, serialized)
    store.hasUnpersistedWrites = !persisted
    if (persisted) lastKnownRaw = serialized as string
    commit(tasks)
  }

  // Adopts whatever is persisted right now, in memory only. Reads the current value rather
  // than trusting a `storage` event's `newValue`: events arrive in order but after the fact, so
  // by the time an older one is handled storage may already hold something newer. And never
  // writes back — re-persisting an adopted (possibly already superseded) value would overwrite
  // another tab's newer write, and re-serializing the whole list on every change in every tab
  // is wasted work besides. Memory now mirrors storage, so there's nothing unpersisted left.
  const syncFromStorage = (): void => {
    const raw = safeGetItem(storageKey)
    // Unchanged *and* memory already matches it: nothing to adopt. While this tab has
    // unpersisted writes, memory differs from `lastKnownRaw` by definition, so an unchanged
    // value (e.g. another tab wrote and then restored it) must still be adopted — skipping it
    // while clearing the flag would claim memory mirrors storage when it doesn't.
    if (raw === lastKnownRaw && !store.hasUnpersistedWrites) return
    store.hasUnpersistedWrites = false
    lastKnownRaw = raw
    const tasks = parseTasksFromStorageValue<TType>(raw)
    warnIfTaskListTooLarge(tasks.length)
    commit(tasks)
  }

  const handleStorageEvent = (event: StorageEvent): void => {
    // `key: null` is `localStorage.clear()` (in another tab) — it wiped this entry too.
    if (event.key !== null && event.key !== storageKey) return
    // sessionStorage changes fire the same event; only localStorage is this store's.
    try {
      if (event.storageArea !== null && event.storageArea !== localStorage) return
    } catch {
      return // `localStorage` itself inaccessible: nothing this store could sync from anyway
    }
    syncFromStorage()
  }

  // The window listener lives only while someone is subscribed — so a store that nothing
  // observes holds no global listener (and can be garbage-collected), and one that's observed
  // never misses another tab's write.
  const startSyncing = (): void => {
    if (typeof window === "undefined") return
    window.addEventListener("storage", handleStorageEvent)
    // Other tabs may have written while nothing was listening. Skipped while this tab has
    // unpersisted writes: storage doesn't hold them, so adopting it would drop tasks that
    // exist only in memory (e.g. with storage unavailable, where it reads back empty).
    if (!store.hasUnpersistedWrites) syncFromStorage()
  }
  const stopSyncing = (): void => {
    if (typeof window === "undefined") return
    window.removeEventListener("storage", handleStorageEvent)
  }

  // `hasUnpersistedWrites` remembers a write failure: once one happens, localStorage no longer
  // reflects this tab's state, so the next mutator must build on the in-memory snapshot
  // (`state.tasks`) instead of `readPersisted()` — otherwise it would silently resurrect the
  // stale persisted snapshot and discard whatever only lives in memory. Once a write succeeds
  // again, persisted and memory are back in sync, so mutators go back to reading persisted
  // first (to avoid resurrecting a task another tab removed).
  const base = (): PendingTask<TType>[] => (store.hasUnpersistedWrites ? state.tasks : readPersisted())

  lastKnownRaw = safeGetItem(storageKey)
  const initialTasks = parseTasksFromStorageValue<TType>(lastKnownRaw)
  // The initial load doesn't go through `writeTasks` (nothing to write back), so it checks the
  // size itself — an app that starts up with an already-oversized persisted list should be
  // warned on load, not only on its next mutation.
  warnIfTaskListTooLarge(initialTasks.length)
  state = {
    tasks: initialTasks,
    addTask: (task) => {
      const next = base().filter((t) => t.id !== task.id)
      next.push(task)
      writeTasks(next)
    },
    removeTask: (id) => {
      writeTasks(base().filter((t) => t.id !== id))
    },
    updateTask: (id, patch) => {
      writeTasks(base().map((t) => (t.id === id ? { ...t, ...patch } : t)))
    },
    pruneTasksBy: (predicate) => {
      writeTasks(base().filter(predicate))
    },
    clearAllTasks: () => writeTasks([]),
  }

  const store: PendingTaskStore<TType> = {
    getState: () => state,
    subscribe: (listener) => {
      if (subscriptions.size === 0) startSyncing()
      const subscription: Subscription = { listener, lastState: state }
      subscriptions.add(subscription)
      return () => {
        if (!subscriptions.delete(subscription)) return
        if (subscriptions.size === 0) stopSyncing()
      }
    },
    storageKey,
    hasUnpersistedWrites: false,
    writeTasks,
  }
  return store
}
