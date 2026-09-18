import { create, type StoreApi, type UseBoundStore } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { safeGetItem } from "./safe-storage"
import type { PendingTask } from "./types"

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_STORAGE_KEY = "pending-tasks"
/** Default for `CreatePendingTaskStoreOptions.taskListWarnThreshold` — see its doc comment. */
export const DEFAULT_TASK_LIST_WARN_THRESHOLD = 200

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

export type PendingTaskStore<TType extends string = string> = UseBoundStore<
  StoreApi<PendingTaskStoreState<TType>>
> & {
  storageKey: string
  /**
   * True when the most recent write to this store's localStorage entry threw (quota exceeded,
   * Safari private browsing, storage disabled, ...) instead of landing — by whichever writer
   * made it: this store's own mutators, or an external batched write via `writeTasks` (e.g.
   * `PendingTaskPoller`'s `flushBatch`/cross-tab `storage` sync). While true, persisted storage
   * no longer reflects this tab's in-memory state, so anything about to rebuild `tasks` from a
   * freshly-read persisted snapshot should build on `getState().tasks` instead, and anything
   * checking "does another tab already have this task" (e.g. `addTaskIfMissing`) should not
   * trust a persisted-storage read either. Flips back to `false` as soon as a write through
   * this store's own mutators or `writeTasks` succeeds again.
   *
   * This is the single shared source of truth for that fact — treat it as read-only from
   * outside this module; it's written only by this store's own mutators and by `writeTasks`.
   */
  hasUnpersistedWrites: boolean
  /**
   * Writes `tasks` to this store the same way its own mutators do, through the single shared
   * safe-write path that also updates `hasUnpersistedWrites`. Anything outside this module that
   * replaces the whole `tasks` array wholesale (currently `PendingTaskPoller`'s batched
   * `flushBatch` writes and its cross-tab `storage`-event sync) must go through this instead of
   * calling `setState` directly — otherwise its own write failures would be invisible to this
   * store's mutators (and vice versa), letting the two silently drift out of sync about whether
   * persisted storage can currently be trusted.
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
   * the count crosses this threshold, `console.warn`s exactly once for this store's lifetime
   * (never again after, even if the count keeps climbing) — not a hard limit, tasks keep being
   * tracked normally either way. Defaults to `DEFAULT_TASK_LIST_WARN_THRESHOLD` (200); set to
   * `Infinity` to disable if your app genuinely needs to track more.
   */
  taskListWarnThreshold?: number
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

/** Parses the raw string a zustand-persist localStorage entry holds, tolerating garbage/foreign values. */
export function parseTasksFromStorageValue<TType extends string = string>(
  value: string | null,
): PendingTask<TType>[] {
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
 *  SecurityError (see `safe-storage.ts`'s own doc comment) — reading it unguarded here would
 *  propagate straight out of every store mutator, `addTaskIfMissing`, and `flushBatch`, in a
 *  package that otherwise degrades every other localStorage access safely. */
export function readPersistedTasks<TType extends string = string>(
  storageKey: string,
): PendingTask<TType>[] {
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
  const readPersisted = (): PendingTask<TType>[] => readPersistedTasks<TType>(storageKey)

  // Fires at most once per store instance — see `taskListWarnThreshold`'s doc comment.
  let hasWarnedAboutTaskListSize = false

  const warnIfTaskListTooLarge = (length: number): void => {
    if (hasWarnedAboutTaskListSize || length <= taskListWarnThreshold) return
    hasWarnedAboutTaskListSize = true
    try {
      // Wrapped in its own try/catch, entirely separate from the setState try/catch below: a
      // `console` that's missing entirely, or a `console.warn` override that itself throws,
      // must not prevent the actual task-list write that follows this.
      console.warn(
        `pending-task-kit: tracking ${length} tasks for storageKey "${storageKey}", past the ` +
          `soft warning threshold of ${taskListWarnThreshold}. The whole list is persisted as a ` +
          "single localStorage entry on every change — a very large list risks the ~5MB per-origin " +
          "quota and slows down every write. Consider pruning stale tasks more aggressively (see " +
          "pruneTasksBy), or pass a higher taskListWarnThreshold if this app genuinely needs to track " +
          "this many.",
      )
    } catch {
      // See the comment above — degrade silently rather than let a broken console take down a
      // write.
    }
  }

  // zustand's persist writes to localStorage synchronously inside setState() — a throwing
  // write (quota exceeded, Safari private browsing, storage disabled) would otherwise propagate
  // straight out of whichever caller triggered it. The in-memory state has already been applied
  // by the time persist's write runs, so swallowing the write failure here just degrades
  // persistence to this-tab-only rather than crashing the caller (same treatment
  // `createTtlDedupeCache` already gives this failure mode). This is the ONLY place that writes
  // `useStore.hasUnpersistedWrites` — this store's own mutators and `writeTasks` (the external
  // entry point `PendingTaskPoller` uses for its batched/cross-tab writes) both route through
  // it, so a write failure on either path is visible to both instead of each tracking its own
  // disconnected flag. Also the single choke point every task-list mutation passes through,
  // which is why the size warning check runs here too (see also `onRehydrateStorage` below, for
  // the one path — the initial load — that doesn't go through this).
  const writeTasks = (tasks: PendingTask<TType>[]): void => {
    warnIfTaskListTooLarge(tasks.length)
    try {
      useStore.setState({ tasks })
      useStore.hasUnpersistedWrites = false
    } catch {
      useStore.hasUnpersistedWrites = true
    }
  }

  const useStore = create<PendingTaskStoreState<TType>>()(
    persist(
      (_set, get) => {
        // `hasUnpersistedWrites` remembers a write failure: once one happens, localStorage no
        // longer reflects this tab's state, so the next mutator must build on the in-memory
        // snapshot (`get().tasks`) instead of `readPersisted()` — otherwise it would silently
        // resurrect the stale persisted snapshot and discard whatever only lives in memory.
        // Once a write succeeds again, persisted and memory are back in sync, so mutators go
        // back to reading persisted first (to avoid resurrecting a task another tab removed).
        const base = (): PendingTask<TType>[] =>
          useStore.hasUnpersistedWrites ? get().tasks : readPersisted()

        return {
          tasks: [],
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
      },
      {
        name: storageKey,
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({ tasks: state.tasks }),
        // The one path that bypasses `writeTasks` (and so its size-warning check) entirely:
        // zustand's own initial rehydrate-from-storage on store creation calls its internal
        // `setState` directly, not through `writeTasks`. Without this, an app that starts up
        // with an already-oversized persisted list would only ever get warned on its *next*
        // mutation, not on load — the case this app most needs the warning for.
        onRehydrateStorage: () => (state) => {
          if (state) warnIfTaskListTooLarge(state.tasks.length)
        },
      },
    ),
  ) as unknown as PendingTaskStore<TType>

  useStore.storageKey = storageKey
  useStore.hasUnpersistedWrites = false
  useStore.writeTasks = writeTasks
  return useStore
}
