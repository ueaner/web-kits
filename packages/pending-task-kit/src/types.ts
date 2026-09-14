/** What `handler.check()` itself reports about the task on a given poll: still going, or
 *  finished — with the finished outcome being a business-level judgment (`success`/`failure`)
 *  the handler makes, not something the engine interprets. */
export type PendingTaskStatus = "pending" | "success" | "failure"

/**
 * The final way a task's tracking concluded, as reported to `onResult`:
 * - `success`/`failure` — `check()` gave a definite answer (mirrors `PendingTaskStatus`).
 * - `error` — `check()` itself kept throwing until `maxFailureCount` was reached; the engine
 *   never learned whether the task actually succeeded or failed.
 * - `expired` — the task's TTL ran out before a definite answer arrived; same "never learned
 *   the outcome" situation as `error`, just timed out rather than failing outright.
 */
export type PendingTaskResultStatus = "success" | "failure" | "error" | "expired"

/**
 * Free-form bag for whatever your app wants attached to a task — a display title, a link, an
 * owning user/tenant id, whatever `check()` or your UI needs. Entirely yours: the engine never
 * reads or writes anything in here (see `PendingTask.failureCount`/`ttlMs` for the fields it
 * *does* maintain itself — kept as separate top-level fields precisely so they can never
 * collide with a key you pick here).
 */
export type PendingTaskMetadata = Record<string, unknown>

export interface PendingTask<TType extends string = string> {
  /** Stable, globally-unique id. Re-adding a task with the same id replaces it. */
  id: string
  type: TType
  taskId: number | string
  startedAt: number
  lastCheckedAt?: number
  /** Consecutive check-failure count; maintained by the poller, not by handlers. */
  failureCount?: number
  /** TTL (ms) frozen onto the task at creation time — see `PendingTaskRegistry.addTask`. */
  ttlMs?: number
  metadata?: PendingTaskMetadata
}

export interface PendingTaskCheckResult {
  status: PendingTaskStatus
  /** Merged into `task.metadata` on the next store update — a percent, a stage name,
   *  a step count, or whatever shape your handler's progress reporting needs. */
  progress?: Record<string, unknown>
  /**
   * Free-form payload for the caller's own `onResult` handling — a link, a toast message,
   * an action-button label, what cache to invalidate, or anything else. The engine has no
   * opinion on shape or on what a "result" should look like; it only ever passes this through.
   */
  data?: unknown
}

export interface PendingTaskHandler<TType extends string = string> {
  check: (task: PendingTask<TType>) => Promise<PendingTaskCheckResult>
  /** How often (ms) this task type is checked. Defaults to the poller's `defaultPollIntervalMs`. */
  pollIntervalMs?: number
  /** How long (ms) an untracked-to-completion task is kept before being dropped. */
  ttlMs?: number
  /** Force one last `check()` exactly at TTL expiry instead of silently dropping the task. */
  finalCheckOnExpiry?: boolean
  /** Suppress `onResult` for a `failure` or `error` outcome (still resolved internally).
   *  `expired` is always silent regardless of this flag — see `PendingTaskResultStatus`. */
  silentOnFailure?: boolean
  /** Suppress `onResult` for a `success` outcome. */
  silentOnSuccess?: boolean
}

export type PendingTaskRegistry<TType extends string = string> = Partial<
  Record<TType, PendingTaskHandler<TType>>
>

export interface PendingTaskResultEventDetail<TType extends string = string> {
  task: PendingTask<TType>
  status: PendingTaskResultStatus
  data?: unknown
}
