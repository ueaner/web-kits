export interface TabLockContext {
  /** Aborted when `timeoutMs` expires; pass it to `fetch` etc. so a timeout becomes a real
   *  cancellation rather than just a rejected promise. Note this and `options.signal` are two
   *  independent signals — `options.signal` aborts the *wait* for the lock (keeping the Web
   *  Locks platform naming), `timeoutSignal` tells the *operation* to stop. The names differ
   *  on purpose: their lifecycles and triggers differ, and one shared name would be misread. */
  readonly timeoutSignal: AbortSignal
}

export interface TabLockOptions {
  /** Forwarded to `navigator.locks.request` — aborts the *wait* for the lock (the returned
   *  promise rejects with an `AbortError`) if the signal fires before the lock is granted.
   *  Has no effect once `operation` is already running, and is ignored entirely in the
   *  no-Web-Locks fallback path. */
  signal?: AbortSignal
  /**
   * If `operation` hasn't settled within this many milliseconds, the returned promise rejects
   * with a `TimeoutError`, `ctx.timeoutSignal` aborts, and — on the Web Locks path — the lock
   * is released so other tabs aren't blocked forever by a hung operation. JS can't forcibly
   * interrupt uncooperative code, so the operation itself keeps running in the background and
   * its eventual result is discarded — after a timeout, mutual exclusion is briefly broken and
   * two tabs can be inside `operation` at once, so side effects inside should be idempotent.
   * A non-positive value rejects immediately.
   */
  timeoutMs?: number
}

/** The result of `tryWithTabLock`: either the lock was acquired and `operation` ran, or it
 *  was skipped because another tab holds the lock. */
export type TabLockResult<T> = { acquired: true; value: T } | { acquired: false }

function settleWithin<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  timeoutMs: number | undefined,
  timeoutController: AbortController,
): Promise<T> {
  if (timeoutMs === undefined) return Promise.resolve().then(() => operation({ timeoutSignal: timeoutController.signal }))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
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
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
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
 * Web Locks are not re-entrant: calling `withTabLock` with the same `name` from inside
 * `operation` (directly or transitively) deadlocks, as does acquiring multiple lock names in
 * inconsistent order across code paths. `timeoutMs` doesn't bound the *wait* for the lock —
 * pass `signal` if that wait must be abortable.
 */
export async function withTabLock<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  options?: TabLockOptions,
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  const run = () => settleWithin(name, operation, options?.timeoutMs, new AbortController())

  if (!locks) {
    return run()
  }

  if (options?.signal) {
    return locks.request(name, { signal: options.signal }, run)
  }
  return locks.request(name, run)
}

/**
 * The skip-if-busy sibling of `withTabLock` — implemented with Web Locks' `ifAvailable`:
 * if another tab holds the lock, `operation` doesn't run at all and the result is
 * `{ acquired: false }` instead of queueing behind the holder. Queueing is the wrong
 * semantic for the canonical use case (auth token refresh: every queued tab would refresh
 * once each, and the refresh endpoint gets rate-limited); the caller that skipped should
 * wait for the holder's result (e.g. via a storage event) or retry later.
 *
 * On the no-Web-Locks fallback path there is no lock to contend for, so "skip" has no
 * meaning: `operation` runs and the result reports `acquired: true`.
 */
export async function tryWithTabLock<T>(
  name: string,
  operation: (ctx: TabLockContext) => Promise<T> | T,
  options?: TabLockOptions,
): Promise<TabLockResult<T>> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  const run = () => settleWithin(name, operation, options?.timeoutMs, new AbortController())

  if (!locks) {
    return { acquired: true, value: await run() }
  }

  return locks.request(name, { ifAvailable: true, ...(options?.signal ? { signal: options.signal } : {}) }, async (lock) => {
    if (!lock) return { acquired: false }
    return { acquired: true, value: await run() }
  })
}
