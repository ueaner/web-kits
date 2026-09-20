import { vi } from "vitest"

export interface FakeLock {
  readonly name: string
}

type LockCallback = (lock: FakeLock | null) => unknown

interface LockRequestOptions {
  ifAvailable?: boolean
  signal?: AbortSignal
}

interface PendingRequest {
  callback: LockCallback
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export interface FakeLockManager {
  request(name: string, callback: LockCallback): Promise<unknown>
  request(name: string, options: LockRequestOptions, callback: LockCallback): Promise<unknown>
  /** How many requests are queued waiting on a name. */
  pendingCount(name: string): number
  isHeld(name: string): boolean
}

/**
 * A controllable stand-in for `navigator.locks` (Web Locks API). Only what cross-tab-kit
 * uses is modeled: exclusive-mode `request`, FIFO grant order per name, `ifAvailable`
 * (callback runs with a null lock instead of queueing), and `signal` aborting the wait.
 *
 * A lock is held until the granted callback's returned promise settles, so tests control
 * hold duration — and "never releases" / "frozen holder" scenarios — by controlling their
 * own callbacks (e.g. returning a promise they resolve later, or never).
 */
export function createFakeLocks(): FakeLockManager {
  const held = new Set<string>()
  const queues = new Map<string, PendingRequest[]>()

  const grant = async (name: string, callback: LockCallback): Promise<unknown> => {
    held.add(name)
    try {
      return await callback({ name })
    } finally {
      held.delete(name)
      drain(name)
    }
  }

  const drain = (name: string) => {
    const next = queues.get(name)?.shift()
    if (!next) return
    void grant(name, next.callback).then(next.resolve, next.reject)
  }

  const request = (name: string, optionsOrCallback: LockRequestOptions | LockCallback, maybeCallback?: LockCallback): Promise<unknown> => {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : (maybeCallback as LockCallback)

    // The real Web Locks API throws synchronously (a TypeError) when `signal` is combined
    // with `ifAvailable` (or `steal`) — modeled here so a caller that violates it fails the
    // same way against the fake as it would in a real browser.
    if (options.ifAvailable && options.signal) {
      throw new TypeError("cross-tab-kit test double: signal is not allowed with ifAvailable")
    }

    // The real Web Locks API rejects with the signal's own `reason` (an AbortError DOMException
    // by default, or whatever the caller passed to `abort(reason)`) — not a generic error of
    // its own — so the fake matches that instead of hardcoding one.
    const abortReason = () => options.signal?.reason ?? new DOMException("cross-tab-kit test double: lock request aborted", "AbortError")
    if (options.signal?.aborted) return Promise.reject(abortReason())

    const queue = queues.get(name) ?? []
    if (!held.has(name) && queue.length === 0) {
      return grant(name, callback)
    }
    if (options.ifAvailable) {
      return Promise.resolve().then(() => callback(null))
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { callback, resolve, reject }
      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            const index = queue.indexOf(pending)
            if (index >= 0) queue.splice(index, 1)
            reject(abortReason())
          },
          { once: true },
        )
      }
      queue.push(pending)
      queues.set(name, queue)
    })
  }

  return {
    request: request as FakeLockManager["request"],
    pendingCount: (name) => queues.get(name)?.length ?? 0,
    isHeld: (name) => held.has(name),
  }
}

/** Stubs `navigator` with a fresh fake lock manager; pair with `vi.unstubAllGlobals()`. */
export function installFakeLocks(): FakeLockManager {
  const locks = createFakeLocks()
  vi.stubGlobal("navigator", { locks })
  return locks
}
