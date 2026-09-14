import { create, type StoreApi, type UseBoundStore } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { PendingTask } from "./types"

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_STORAGE_KEY = "pending-tasks"

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
}

function isPendingTaskShape(value: unknown): value is PendingTask {
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
 *  in this tab may not yet reflect a write another tab just made. */
export function readPersistedTasks<TType extends string = string>(
  storageKey: string,
): PendingTask<TType>[] {
  if (typeof localStorage === "undefined") return []
  return parseTasksFromStorageValue<TType>(localStorage.getItem(storageKey))
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
  const readPersisted = (): PendingTask<TType>[] => readPersistedTasks<TType>(storageKey)

  // zustand's persist writes to localStorage synchronously inside setState() — a throwing
  // write (quota exceeded, Safari private browsing, storage disabled) would otherwise propagate
  // straight out of whichever caller triggered it. The in-memory state has already been applied
  // by the time persist's write runs, so swallowing the write failure here just degrades
  // persistence to this-tab-only rather than crashing the caller (same treatment
  // `createTtlDedupeCache` already gives this failure mode). This is the ONLY place that writes
  // `useStore.hasUnpersistedWrites` — this store's own mutators and `writeTasks` (the external
  // entry point `PendingTaskPoller` uses for its batched/cross-tab writes) both route through
  // it, so a write failure on either path is visible to both instead of each tracking its own
  // disconnected flag.
  const writeTasks = (tasks: PendingTask<TType>[]): void => {
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
      },
    ),
  ) as unknown as PendingTaskStore<TType>

  useStore.storageKey = storageKey
  useStore.hasUnpersistedWrites = false
  useStore.writeTasks = writeTasks
  return useStore
}
