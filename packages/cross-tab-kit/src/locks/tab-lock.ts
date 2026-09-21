import { linkAbortSignal } from "../kernel/abort"
import { assertPositiveFiniteMs } from "../kernel/logger"

export interface TabLockContext {
  /** Aborted when `timeoutMs` expires; pass it to `fetch` etc. so a timeout becomes a real
   *  cancellation rather than just a rejected promise. Note this and `options.signal` are two
   *  independent signals — `options.signal` aborts the *wait* for the lock (keeping the Web
   *  Locks platform naming), `timeoutSignal` tells the *operation* to stop. The names differ
   *  on purpose: their lifecycles and triggers differ, and one shared name would be misread. */
  readonly timeoutSignal: AbortSignal
}

export interface TabLockOptions {
  /** Forwarded (merged with `waitTimeoutMs`'s own timer) to `navigator.locks.request` —
   *  aborts the *wait* for the lock (the returned promise rejects with an `AbortError`) if
   *  the signal fires before the lock is granted. Has no effect once `operation` is already
   *  running, and is ignored entirely in the no-Web-Locks fallback path. */
  signal?: AbortSignal
  /**
   * If `operation` hasn't settled within this many milliseconds, the returned promise rejects
   * with a `TimeoutError`, `ctx.timeoutSignal` aborts, and — on the Web Locks path — the lock
   * is released so other tabs aren't blocked forever by a hung operation. JS can't forcibly
   * interrupt uncooperative code, so the operation itself keeps running in the background and
   * its eventual result is discarded — after a timeout, mutual exclusion is briefly broken and
   * two tabs can be inside `operation` at once, so side effects inside should be idempotent.
   */
  timeoutMs?: number
  /**
   * How long to wait for the lock to be granted before rejecting with a `TimeoutError`
   * (message: `timed out waiting <N>ms for tab lock "<name>"`). Required on purpose: an
   * unbounded wait is how one tab's hung operation silently stalls every same-name waiter
   * across all tabs, so the caller must make the tradeoff explicit. Pass `Infinity` to wait
   * without a bound. Ignored on the no-Web-Locks fallback path (there is no wait there), but
   * still required and validated. Must be a positive finite number or `Infinity`.
   *
   * If the wait times out while *this same tab* holds the lock, the rejection's message says
   * so: Web Locks are not re-entrant, and a nested same-name `withTabLock` can only ever end
   * in that timeout — the message calls it out instead of leaving a mysterious stall.
   */
  waitTimeoutMs: number
}

/** `tryWithTabLock` never queues, so it has no wait to bound — its options are
 *  `TabLockOptions` minus `waitTimeoutMs`, and stay optional. */
export type TryTabLockOptions = Omit<TabLockOptions, "waitTimeoutMs">

/** The result of `tryWithTabLock`: either the lock was acquired and `operation` ran, or it
 *  was skipped because another tab holds the lock. */
export type TabLockResult<T> = { acquired: true; value: T } | { acquired: false }

/** Locks this tab currently holds, by name — used only as a hint for the nested-same-name
 *  deadlock diagnostic below: a wait that times out while this tab already holds the name is
 *  *consistent with* that deadlock (Web Locks are not re-entrant), though it can't distinguish
 *  a true nested call from two unrelated same-name calls racing in the same tab — see the
 *  message's wording. Entries are deleted (not left at 0) once nobody holds the name, so this
 *  doesn't grow without bound for apps that use dynamically-named locks. */
const heldLockCounts = new Map<string, number>()

function assertValidWaitTimeoutMs(waitTimeoutMs: number, apiName: string): void {
  if (waitTimeoutMs === Infinity) return
  assertPositiveFiniteMs(waitTimeoutMs, apiName, "waitTimeoutMs")
}

/** The largest delay `setTimeout` accepts before it overflows its 32-bit signed int and fires
 *  almost immediately instead (~24.8 days). `waitTimeoutMs`/`timeoutMs` are typed as any
 *  positive finite number, so a caller can legally exceed this — chain timers rather than
 *  handing the raw value to `setTimeout`, so a very long timeout still waits the full
 *  duration instead of firing early. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

function setChainedTimeout(callback: () => void, delayMs: number): () => void {
  let cancelled = false
  let handle: ReturnType<typeof setTimeout>
  const schedule = (remaining: number) => {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS)
    handle = setTimeout(() => {
      if (cancelled) return
      const left = remaining - chunk
      if (left > 0) schedule(left)
      else callback()
    }, chunk)
  }
  schedule(delayMs)
  return () => {
    cancelled = true
    clearTimeout(handle)
  }
}

function settleWithin<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  timeoutMs: number | undefined,
  timeoutController: AbortController,
): Promise<T> {
  if (timeoutMs === undefined) return Promise.resolve().then(() => operation({ timeoutSignal: timeoutController.signal }))
  return new Promise<T>((resolve, reject) => {
    const cancelTimer = setChainedTimeout(() => {
      // Abort first, then reject: the abort is the operation's cue to stop (its fetches
      // cancel), the rejection is what actually releases the lock on the Web Locks path.
      timeoutController.abort()
      reject(new DOMException(`cross-tab-kit: tab lock "${name}" timed out after ${timeoutMs}ms`, "TimeoutError"))
    }, timeoutMs)
    // `Promise.resolve().then(...)` so a synchronous throw from `operation` still becomes a
    // rejection that clears the timer, instead of escaping `settleWithin` as a throw.
    Promise.resolve()
      .then(() => operation({ timeoutSignal: timeoutController.signal }))
      .then(
        (value) => {
          cancelTimer()
          resolve(value)
        },
        (error) => {
          cancelTimer()
          reject(error)
        },
      )
  })
}

/**
 * Runs `operation` under a named Web Locks API lock (`navigator.locks`), so that
 * only one browser tab executes it at a time. Falls back to running `operation`
 * un-locked when the Web Locks API isn't available (older browsers, non-browser
 * environments, or insecure contexts); `timeoutMs` is still honored on that path.
 *
 * The two timeouts divide the lifecycle: `waitTimeoutMs` bounds the *wait* for the lock,
 * `timeoutMs` bounds the *operation* once the lock is held.
 *
 * Web Locks are not re-entrant: calling `withTabLock` with the same `name` from inside
 * `operation` (directly or transitively) deadlocks — surfacing here as the inner call's
 * `waitTimeoutMs` rejection, whose message names the nested call as a likely cause — as does
 * acquiring multiple lock names in inconsistent order across code paths.
 *
 * An invalid `waitTimeoutMs`/`timeoutMs` throws synchronously (not as a rejected promise) —
 * it's a misconfiguration caught at the call site, not a runtime condition to route through
 * `.catch()`.
 */
export function withTabLock<T>(name: string, operation: (ctx: TabLockContext) => Promise<T> | T, options: TabLockOptions): Promise<T> {
  // Misconfiguration, not a runtime condition — throw synchronously at the call site.
  assertValidWaitTimeoutMs(options.waitTimeoutMs, "withTabLock")
  if (options.timeoutMs !== undefined) assertPositiveFiniteMs(options.timeoutMs, "withTabLock", "timeoutMs")

  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  const run = () => settleWithin(name, operation, options.timeoutMs, new AbortController())

  if (!locks) {
    // Degraded path: no lock exists, so there is no wait to bound — waitTimeoutMs is moot.
    return run()
  }

  // Merge the caller's signal with the wait deadline by hand (not AbortSignal.any, for
  // compatibility): the caller's abort surfaces as the platform's AbortError (preserving its
  // `reason`), our own timer's as a TimeoutError naming the lock.
  const waitController = new AbortController()
  let waitTimedOut = false
  const cancelWaitTimer =
    options.waitTimeoutMs === Infinity
      ? undefined
      : setChainedTimeout(() => {
          waitTimedOut = true
          waitController.abort()
        }, options.waitTimeoutMs)
  const unlinkUserSignal = options.signal ? linkAbortSignal(options.signal, waitController) : undefined

  const clearWait = () => {
    cancelWaitTimer?.()
    unlinkUserSignal?.()
  }

  const runLocked = (): Promise<T> => {
    clearWait() // the lock is granted — the wait phase is over
    heldLockCounts.set(name, (heldLockCounts.get(name) ?? 0) + 1)
    return settleWithin(name, operation, options.timeoutMs, new AbortController()).finally(() => {
      const remaining = (heldLockCounts.get(name) ?? 1) - 1
      if (remaining <= 0) heldLockCounts.delete(name)
      else heldLockCounts.set(name, remaining)
    })
  }

  return Promise.resolve(locks.request(name, { signal: waitController.signal }, runLocked))
    .then(
      (value) => value as T,
      (error: unknown) => {
        if (waitTimedOut) {
          // `heldLockCounts` can't tell a true nested call (Web Locks aren't re-entrant, so
          // that always ends in exactly this timeout) apart from two unrelated same-name
          // calls racing in this same tab — the wording below covers both without asserting
          // a deadlock the runtime can't actually confirm.
          const maybeNested = (heldLockCounts.get(name) ?? 0) > 0
          throw new DOMException(
            `cross-tab-kit: timed out waiting ${options.waitTimeoutMs}ms for tab lock "${name}"` +
              (maybeNested
                ? " — this tab itself currently holds that lock; if this call is nested inside the one holding it (directly or transitively), that's the deadlock — Web Locks aren't re-entrant, so a nested same-name withTabLock call deadlocks. If these are two unrelated calls instead, this is ordinary contention, not a deadlock."
                : ""),
            "TimeoutError",
          )
        }
        throw error
      },
    )
    .finally(clearWait)
}

/**
 * The skip-if-busy sibling of `withTabLock` — implemented with Web Locks' `ifAvailable`:
 * if another tab holds the lock, `operation` doesn't run at all and the result is
 * `{ acquired: false }` instead of queueing behind the holder. Queueing is the wrong
 * semantic for the canonical use case (auth token refresh: every queued tab would refresh
 * once each, and the refresh endpoint gets rate-limited); the caller that skipped should
 * wait for the holder's result (e.g. via a storage event) or retry later. Since it never
 * queues, there is no wait to bound — hence no `waitTimeoutMs`.
 *
 * `options.signal` is honored only as a pre-check (an already-aborted signal skips the
 * attempt entirely): Web Locks throws if `signal` is combined with `ifAvailable` on the
 * request itself, and there's no wait phase here for it to abort mid-flight anyway.
 *
 * On the no-Web-Locks fallback path there is no lock to contend for, so "skip" has no
 * meaning: `operation` runs and the result reports `acquired: true`.
 */
export function tryWithTabLock<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  options?: TryTabLockOptions,
): Promise<TabLockResult<T>> {
  if (options?.timeoutMs !== undefined) assertPositiveFiniteMs(options.timeoutMs, "tryWithTabLock", "timeoutMs")

  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  const run = () => settleWithin(name, operation, options?.timeoutMs, new AbortController())

  if (!locks) {
    return run().then((value) => ({ acquired: true as const, value }))
  }

  if (options?.signal?.aborted) {
    return Promise.reject(options.signal.reason)
  }

  // `signal` is deliberately not forwarded to `locks.request` — combining it with
  // `ifAvailable` is a spec violation that throws a TypeError, and `ifAvailable` never
  // queues, so there is no wait for the signal to abort in the first place.
  return Promise.resolve(
    locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return { acquired: false as const }
      return { acquired: true as const, value: await run() }
    }),
  )
}
