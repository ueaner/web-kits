export interface TabLockOptions {
  /** Forwarded to `navigator.locks.request` — aborts the *wait* for the lock (the returned
   *  promise rejects with an `AbortError`) if the signal fires before the lock is granted.
   *  Has no effect once `operation` is already running, and is ignored entirely in the
   *  no-Web-Locks fallback path. */
  signal?: AbortSignal
  /**
   * If `operation` hasn't settled within this many milliseconds, the returned promise rejects
   * with a `TimeoutError` and — on the Web Locks path — the lock is released so other tabs
   * aren't blocked forever by a hung operation. Note the operation itself is not cancelled
   * (there's no general way to cancel arbitrary user code): it keeps running in the background
   * and its eventual result is simply discarded. A non-positive value rejects immediately.
   */
  timeoutMs?: number
}

function settleWithin<T>(name: string, operation: () => Promise<T> | T, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return Promise.resolve().then(operation)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException(`cross-tab-kit: withTabLock("${name}") timed out after ${timeoutMs}ms`, "TimeoutError"))
    }, timeoutMs)
    // `Promise.resolve().then(operation)` so a synchronous throw from `operation` still becomes a
    // rejection that clears the timer, instead of escaping `settleWithin` as a throw.
    Promise.resolve()
      .then(operation)
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
 */
export async function withTabLock<T>(name: string, operation: () => Promise<T> | T, options?: TabLockOptions): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  const run = () => settleWithin(name, operation, options?.timeoutMs)

  if (!locks) {
    return run()
  }

  if (options?.signal) {
    return locks.request(name, { signal: options.signal }, run)
  }
  return locks.request(name, run)
}
