import { readPersistedTasks } from "./store"
import type { PendingTaskStore } from "./store"
import type { PendingTask, PendingTaskRegistry } from "./types"

/**
 * Binds a handler registry to a store instance and returns the two entry points
 * apps should use to start tracking a task — never call `store.getState().addTask`
 * directly, since that would skip freezing `ttlMs` onto the task.
 */
export function createPendingTaskRegistryBinding<TType extends string = string>(
  store: PendingTaskStore<TType>,
  registry: PendingTaskRegistry<TType>,
) {
  /**
   * Registers a task for polling. If the task's type has a handler with `ttlMs` set,
   * that value is frozen onto `task.ttlMs` now — so a later change to the handler's
   * `ttlMs` can't retroactively alter an already-in-flight task's expiry.
   *
   * Fully replaces any existing task with the same id (resets `startedAt`/metadata).
   */
  function addTask(task: PendingTask<TType>): void {
    const handler = registry[task.type]
    const ttlMs = handler?.ttlMs
    const withTtl: PendingTask<TType> = ttlMs === undefined ? task : { ...task, ttlMs }
    store.getState().addTask(withTtl)
  }

  /**
   * Idempotent variant of `addTask` — only registers the task if one with the same id
   * isn't already tracked. Use this to resume polling a possibly-already-running task
   * (e.g. re-selecting a history item that's still in progress) without resetting its
   * `startedAt`/progress the way `addTask` would.
   *
   * Checks both the in-memory store and localStorage directly: another tab's write can
   * land in localStorage slightly before this tab's `storage` listener has re-synced the
   * in-memory snapshot, and trusting only the stale snapshot would otherwise re-add (and
   * reset) a task another tab is already tracking.
   *
   * Skips the persisted-storage check while `store.hasUnpersistedWrites` is set: in that
   * window this tab's own writes are failing, so localStorage may still hold a task this tab's
   * memory has already dropped (e.g. a `removeTask` whose write failed) — trusting it there
   * would misread that as "another tab still has it" and wrongly skip re-registering.
   */
  function addTaskIfMissing(task: PendingTask<TType>): void {
    const existsInMemory = store.getState().tasks.some((t) => t.id === task.id)
    const existsPersisted =
      !store.hasUnpersistedWrites &&
      readPersistedTasks<TType>(store.storageKey).some((t) => t.id === task.id)
    if (!existsInMemory && !existsPersisted) {
      addTask(task)
    }
  }

  return { addTask, addTaskIfMissing }
}
