import { DEFAULT_STORAGE_KEY, DEFAULT_TTL_MS, parseTasksFromStorageValue, readPersistedTasks } from "./store"
import type { PendingTaskStore } from "./store"
import type {
  PendingTask,
  PendingTaskCheckResult,
  PendingTaskHandler,
  PendingTaskRegistry,
  PendingTaskResultEventDetail,
} from "./types"

export const DEFAULT_POLL_TICK_MS = 2_000
export const DEFAULT_POLL_INTERVAL_MS = 10_000
export const DEFAULT_MAX_FAILURE_COUNT = 5
export const DEFAULT_RESULT_EVENT = "pending-task-result"

export interface PendingTaskPollerOptions<TType extends string = string> {
  store: PendingTaskStore<TType>
  registry: PendingTaskRegistry<TType>
  /** Called for every non-silent `success`/`failure`/`error` outcome. This is where apps show a toast, navigate, or invalidate a cache — the engine has no opinion on any of that. */
  onResult?: (detail: PendingTaskResultEventDetail<TType>) => void
  /**
   * Called whenever `handler.check` throws, before the normal failure-count/backoff/expiry
   * handling runs. The engine has no notion of auth, tokens, or sessions — if `check()` can
   * fail for a reason that shouldn't count as a normal transient error (e.g. the caller's own
   * session just ended), inspect `error` here and return `true` to skip the normal failure
   * counting and stop the *current* tick early (the task is left as-is, `lastCheckedAt` is
   * still bumped so it isn't treated as overdue again immediately). Return `false`/`undefined`
   * (or omit this option) to fall through to the standard failure-count/backoff/expiry path.
   */
  onCheckError?: (error: unknown, task: PendingTask<TType>) => boolean | void
  /**
   * Optional cross-tab "claim once" gate around the final `onResult`/DOM-event dispatch
   * (task removal from the store always happens regardless). Compose `withTabLock` +
   * `createTtlDedupeCache` here to prevent duplicate toasts when multiple tabs race to
   * process the same completed task.
   */
  claimResultOnce?: (task: PendingTask<TType>) => Promise<boolean> | boolean
  /** How often the engine re-scans the task list. Individual tasks still respect their own poll interval. */
  pollTickMs?: number
  /** Fallback per-check interval (ms) for handlers that don't set `pollIntervalMs`. */
  defaultPollIntervalMs?: number
  /** Fallback TTL (ms) for tasks whose handler doesn't set `ttlMs`. */
  defaultTtlMs?: number
  maxFailureCount?: number
  /** Also `window.dispatchEvent(new CustomEvent(eventName, { detail }))` for cross-component listening. Defaults to true when `window` exists. */
  dispatchDomEvent?: boolean
  eventName?: string
  /** localStorage key the store persists to — must match what `createPendingTaskStore` was given. */
  storageKey?: string
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "Unknown error"
}

/**
 * Framework-agnostic polling engine: scans the store's tasks on an interval, calls the
 * matching handler's `check()`, and resolves each task to `pending` (re-check later),
 * `success`/`failure` (dispatched via `onResult`, then removed), silently-or-not `error`
 * (removed; dispatched unless `silentOnFailure`) when `check()` itself kept failing, or
 * silently expired (removed, never dispatched — unless the handler opts into
 * `finalCheckOnExpiry` for one last check).
 *
 * Framework bindings (see `./react`) are thin wrappers that call `start()`/`stop()` at the
 * right lifecycle moments and expose `forceCheckAll()` for e.g. tab-focus recovery.
 *
 * Note: `stop()` prevents any *new* tick from starting, but a tick already awaiting
 * `handler.check()` when `stop()` is called will still run to completion (there is no
 * `AbortSignal` plumbed into the handler contract). Design handlers to be safe to finish
 * even if the caller has logically "stopped" — e.g. don't assume side effects are undone.
 */
export class PendingTaskPoller<TType extends string = string> {
  private readonly options: Required<
    Omit<PendingTaskPollerOptions<TType>, "onResult" | "onCheckError" | "claimResultOnce">
  > &
    Pick<PendingTaskPollerOptions<TType>, "onResult" | "onCheckError" | "claimResultOnce">

  private intervalId: ReturnType<typeof setInterval> | undefined
  private storageListener: ((event: StorageEvent) => void) | undefined
  private isChecking = false
  private pendingForce = false
  private stopped = false
  private latestTasksCache: { tasks: PendingTask<TType>[]; byId: Map<string, PendingTask<TType>> } | undefined
  /** Task ids that already got their one `finalCheckOnExpiry` attempt, so a repeatedly-failing
   *  final check doesn't get retried every tick. Reset on process restart — worst case that
   *  costs one extra check, never an infinite retry loop.
   *
   *  Every id added here (only when a task is expired, right before its final `check()`) is
   *  removed again before the *same* tick's iteration moves past that task — either by
   *  `finalize()`'s first line, or by the `onCheckError`-intercept branch's explicit delete.
   *  Nothing here is meant to survive past the tick that added it. */
  private readonly finalCheckAttempted = new Set<string>()

  constructor(options: PendingTaskPollerOptions<TType>) {
    this.options = {
      store: options.store,
      registry: options.registry,
      pollTickMs: options.pollTickMs ?? DEFAULT_POLL_TICK_MS,
      defaultPollIntervalMs: options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      defaultTtlMs: options.defaultTtlMs ?? DEFAULT_TTL_MS,
      maxFailureCount: options.maxFailureCount ?? DEFAULT_MAX_FAILURE_COUNT,
      dispatchDomEvent: options.dispatchDomEvent ?? typeof window !== "undefined",
      eventName: options.eventName ?? DEFAULT_RESULT_EVENT,
      storageKey: options.storageKey ?? options.store.storageKey ?? DEFAULT_STORAGE_KEY,
      onResult: options.onResult,
      onCheckError: options.onCheckError,
      claimResultOnce: options.claimResultOnce,
    }
  }

  start(): void {
    this.stopped = false
    if (this.intervalId !== undefined) return

    this.intervalId = setInterval(() => {
      this.runTickSafely(false)
    }, this.options.pollTickMs)

    if (typeof window !== "undefined") {
      this.storageListener = (event: StorageEvent) => {
        if (event.key === null) {
          // localStorage.clear() fires with key: null — treat it as this store being wiped too.
          this.options.store.writeTasks([])
          return
        }
        if (event.key !== this.options.storageKey) return
        // Goes through the store's own `writeTasks` (not `setState` directly) so a throwing
        // re-write here (this tab's own quota/private-mode issue racing another tab's write)
        // updates the same shared `hasUnpersistedWrites` fact this store's mutators and
        // `flushBatch` read, instead of escaping this handler uncaught.
        this.options.store.writeTasks(parseTasksFromStorageValue<TType>(event.newValue))
      }
      window.addEventListener("storage", this.storageListener)
    }

    this.runTickSafely(false)
  }

  stop(): void {
    this.stopped = true
    this.pendingForce = false

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    if (this.storageListener && typeof window !== "undefined") {
      window.removeEventListener("storage", this.storageListener)
      this.storageListener = undefined
    }
  }

  /** Re-check every tracked task right now, bypassing each task's poll interval (e.g. on tab focus). */
  forceCheckAll(): void {
    this.runTickSafely(true)
  }

  /** Fires `runTick`, but instead of leaving its promise `void`-called (which would turn an
   *  exception thrown by a consumer callback — `onResult`, `onCheckError`, or a `dispatchEvent`
   *  listener — into a silent unhandled rejection), re-throws it as an uncaught exception on a
   *  fresh microtask. `runTick`'s own `finally` has already flushed the batch and reset
   *  `isChecking` by the time this ever runs, so a broken consumer callback can't take the
   *  poller down — it just becomes visible the way any other uncaught error in the host
   *  environment would be, instead of vanishing. */
  private runTickSafely(force: boolean): void {
    this.runTick(force).catch((error: unknown) => {
      queueMicrotask(() => {
        throw error
      })
    })
  }

  /** Reads the freshest snapshot of `task` from the store, in case another tab wrote to it
   *  while this tab's `handler.check()` was in flight — narrows, but doesn't eliminate, the
   *  window where a concurrent cross-tab write to the same task could be clobbered.
   *
   *  Indexes `store.getState().tasks` into a Map keyed by id rather than doing a linear find
   *  each call — this is called once per pending/failing task per tick, so a plain find would
   *  make a tick O(n²). The cache keys off the `tasks` array reference, which zustand only
   *  replaces on an actual write, so it's rebuilt only when the store has genuinely changed. */
  private getLatestTask(task: PendingTask<TType>): PendingTask<TType> {
    const tasks = this.options.store.getState().tasks
    if (this.latestTasksCache?.tasks !== tasks) {
      this.latestTasksCache = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) }
    }
    return this.latestTasksCache.byId.get(task.id) ?? task
  }

  /** Applies a whole tick's worth of per-task updates/removals (`patch: null` means "remove")
   *  in a single read-modify-write, instead of one persisted-storage round trip per task.
   *  Reads the freshest persisted list right before writing (same "never resurrect a task
   *  another tab already removed" guarantee `PendingTaskStore`'s own mutators give) — unless
   *  the store's `hasUnpersistedWrites` is set (a write on *any* path for this store, including
   *  this store's own direct mutators, failed and hasn't yet been followed by a success), in
   *  which case persisted storage is stale relative to this tab's memory, so this flush builds
   *  on `store.getState().tasks` instead. Writes through `writeTasks`, which swallows a
   *  throwing write and updates that same shared flag — see the comment in `store.ts`. */
  private flushBatch(batch: Map<string, Partial<PendingTask<TType>> | null>): void {
    if (batch.size === 0) return

    const base = this.options.store.hasUnpersistedWrites
      ? this.options.store.getState().tasks
      : readPersistedTasks<TType>(this.options.storageKey)

    const next: PendingTask<TType>[] = []
    for (const t of base) {
      if (!batch.has(t.id)) {
        next.push(t)
        continue
      }
      const patch = batch.get(t.id)
      if (patch !== null) next.push({ ...t, ...patch })
    }

    this.options.store.writeTasks(next)
  }

  private async finalize(
    task: PendingTask<TType>,
    detail: Omit<PendingTaskResultEventDetail<TType>, "task">,
    handler: PendingTaskHandler<TType> | undefined,
    batch: Map<string, Partial<PendingTask<TType>> | null>,
  ): Promise<void> {
    this.finalCheckAttempted.delete(task.id)
    batch.set(task.id, null)

    if (detail.status === "expired") return

    const silent = detail.status === "success" ? handler?.silentOnSuccess : handler?.silentOnFailure
    if (silent) return

    let claimed: boolean
    try {
      claimed = this.options.claimResultOnce ? await this.options.claimResultOnce(task) : true
    } catch {
      // claimResultOnce is documented as a cross-tab "claim once" gate that can reasonably
      // reject (e.g. a lock timeout) — treat that the same as "another tab already claimed it"
      // and skip the dispatch. The removal above already happened, so nothing is left to retry.
      // Unlike this, an exception from `onResult`/`dispatchEvent` below is a real consumer bug
      // and is deliberately left uncaught — `runTickSafely` surfaces it instead of hiding it.
      return
    }
    if (!claimed) return

    const fullDetail: PendingTaskResultEventDetail<TType> = { task, ...detail }
    this.options.onResult?.(fullDetail)
    if (this.options.dispatchDomEvent && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(this.options.eventName, { detail: fullDetail }))
    }
  }

  private async runTick(force: boolean): Promise<void> {
    if (this.stopped) return

    if (this.isChecking) {
      this.pendingForce = this.pendingForce || force
      return
    }

    const tasks = this.options.store.getState().tasks
    if (tasks.length === 0) return

    this.isChecking = true
    const batch = new Map<string, Partial<PendingTask<TType>> | null>()
    try {
      const now = Date.now()

      for (const task of tasks) {
        const handler = this.options.registry[task.type]
        const ttlMs = task.ttlMs ?? this.options.defaultTtlMs
        const expired = now - task.startedAt >= ttlMs

        if (!handler) {
          // No handler to poll with (e.g. removed/renamed since this task was created) — the
          // only thing we can still do for it is let it expire instead of lingering forever.
          if (expired) {
            await this.finalize(task, { status: "expired" }, handler, batch)
          }
          continue
        }

        const interval = handler.pollIntervalMs ?? this.options.defaultPollIntervalMs
        const lastChecked = task.lastCheckedAt ?? task.startedAt
        const due = force || now - lastChecked >= interval
        const finalAttemptDone = this.finalCheckAttempted.has(task.id)

        if (expired && (!handler.finalCheckOnExpiry || finalAttemptDone)) {
          await this.finalize(task, { status: "expired" }, handler, batch)
          continue
        }

        if (!due && !expired) continue

        if (expired) {
          this.finalCheckAttempted.add(task.id)
        }

        let result: PendingTaskCheckResult
        try {
          result = await handler.check(task)
        } catch (error) {
          let intercepted: boolean | void
          try {
            intercepted = this.options.onCheckError?.(error, task)
          } catch (onCheckErrorError) {
            // onCheckError is documented to return a boolean, not throw — a throw here is a
            // consumer callback bug, same category as an `onResult` throw. Don't let it leak
            // this task's `finalCheckAttempted` entry (fall through to the normal handling
            // below as "not intercepted") or take down the tick; surface it the same way
            // `runTickSafely` surfaces any other consumer-callback exception.
            queueMicrotask(() => {
              throw onCheckErrorError
            })
            intercepted = false
          }

          if (intercepted) {
            // Throttle like a normal check so a caller whose pause is asynchronous (e.g. it
            // still needs to call `stop()` itself) doesn't see this task look overdue again on
            // every following tick in the meantime. This check was intercepted rather than
            // genuinely completed, so it shouldn't consume finalCheckOnExpiry's one last-look
            // allowance — clear the flag so a real final check still happens once polling resumes.
            batch.set(task.id, { lastCheckedAt: now })
            this.finalCheckAttempted.delete(task.id)
            break
          }

          if (expired) {
            // The one extra chance finalCheckOnExpiry grants has now been used — expire rather
            // than entering the generic failure-backoff loop.
            await this.finalize(task, { status: "expired" }, handler, batch)
            continue
          }

          const latest = this.getLatestTask(task)
          const failureCount = (latest.failureCount ?? 0) + 1
          if (failureCount >= this.options.maxFailureCount) {
            await this.finalize(task, { status: "error", data: describeError(error) }, handler, batch)
          } else {
            batch.set(task.id, { lastCheckedAt: now, failureCount })
          }
          continue
        }

        if (result.status === "pending") {
          const latest = this.getLatestTask(task)
          batch.set(task.id, {
            lastCheckedAt: now,
            failureCount: 0,
            metadata: { ...latest.metadata, ...result.progress },
          })
          if (expired) {
            // finalCheckOnExpiry's one last look still came back pending — expire quietly now.
            // (status is "expired" here, so finalize() returns before it could ever throw —
            // no try/catch needed, same as the other expiry finalize calls above.)
            await this.finalize(task, { status: "expired" }, handler, batch)
          }
          continue
        }

        await this.finalize(task, { status: result.status, data: result.data }, handler, batch)
      }
    } finally {
      this.flushBatch(batch)
      this.isChecking = false
      if (this.pendingForce && !this.stopped) {
        this.pendingForce = false
        this.runTickSafely(true)
      }
    }
  }
}
