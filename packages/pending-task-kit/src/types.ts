/** What `handler.check()` itself reports about the task on a given poll: still going, or
 *  finished — with the finished outcome being a business-level judgment (`success`/`failure`)
 *  the handler makes, not something the engine interprets. */
export type PendingTaskStatus = "pending" | "success" | "failure"

/**
 * Diagnostic-warning channel. Every place this package would otherwise `console.warn`
 * (an oversized task list, an invalid `pollLeaseTtlMs`, a task whose `type` has no registered
 * handler, a second poller instance sharing one store in the same tab) goes through this
 * instead when one is provided — pass your own implementation to route those warnings into
 * your telemetry/logging system. Defaults to `console`. A `warn` that throws is swallowed
 * where the warning is best-effort bookkeeping, the same tolerance a broken `console` gets.
 */
export interface PendingTaskLogger {
  warn(message: string): void
}

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
  /**
   * `signal` is aborted when the poller is `stop()`-ed while this particular call is still in
   * flight (nothing else aborts it — losing leadership to another tab is only ever discovered
   * *after* `check()` has already settled, so there's nothing in-flight left to cancel at that
   * point; see `PendingTaskPoller`'s class doc comment). Wire it into your own request (e.g.
   * `fetch(url, { signal })`) if you want a stopped poller to actually cancel outstanding
   * network work instead of just discarding the response when it eventually arrives. Handlers
   * that ignore the parameter keep working exactly as before — nothing requires reading it.
   */
  check: (task: PendingTask<TType>, signal: AbortSignal) => Promise<PendingTaskCheckResult>
  /** How often (ms) this task type is checked. Defaults to the poller's `defaultPollIntervalMs`. */
  pollIntervalMs?: number
  /**
   * Optional backoff for the failure-retry cadence specifically — a `check()` that keeps
   * throwing, before `maxFailureCount` is reached. Given the just-incremented failure count,
   * return the delay (ms) before the next retry. Only consulted once a task has actually failed
   * at least once; a task that's still cleanly polling (never failed, or already recovered back
   * to `failureCount` 0) keeps using `pollIntervalMs`/`defaultPollIntervalMs` regardless. Leave
   * unset to keep today's behavior: failures retry on the same fixed cadence as everything else.
   *
   * A non-finite or non-positive return (`NaN`, `Infinity`, `0`, negative) falls back to the
   * normal `pollIntervalMs`/`defaultPollIntervalMs` cadence rather than being trusted outright
   * — `0`/negative would otherwise retry on essentially every tick, and `NaN` would make the
   * task never look due again. A throw is treated the same way (as if unset for this task this
   * tick) and surfaced as an uncaught exception rather than either being silently swallowed or
   * taking down the rest of the tick's tasks — the same treatment `onCheckError` gets.
   */
  retryBackoffMs?: (failureCount: number) => number
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

export type PendingTaskRegistry<TType extends string = string> = Partial<Record<TType, PendingTaskHandler<TType>>>

export interface PendingTaskResultEventDetail<TType extends string = string> {
  task: PendingTask<TType>
  status: PendingTaskResultStatus
  data?: unknown
}
