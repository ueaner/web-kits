import { afterEach, describe, expect, it, vi } from "vitest"
import { tryWithTabLock, withTabLock } from "../src/locks/tab-lock"
import { installFakeLocks } from "./harness/fake-locks"

describe("withTabLock", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("runs operation and returns its result when Web Locks isn't available", async () => {
    vi.stubGlobal("navigator", {})
    // The degraded path has no wait to bound, but waitTimeoutMs is still required — the
    // caller must make the tradeoff explicitly regardless of environment.
    await expect(withTabLock("lock-a", () => "done", { waitTimeoutMs: 1_000 })).resolves.toBe("done")
  })

  it("runs a synchronous operation without Web Locks", async () => {
    vi.stubGlobal("navigator", {})
    const operation = vi.fn(() => 42)
    await expect(withTabLock("lock-a", operation, { waitTimeoutMs: 1_000 })).resolves.toBe(42)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it("propagates a throw from operation without Web Locks", async () => {
    vi.stubGlobal("navigator", {})
    await expect(
      withTabLock(
        "lock-a",
        () => {
          throw new Error("boom")
        },
        { waitTimeoutMs: 1_000 },
      ),
    ).rejects.toThrow("boom")
  })

  it("runs operation inside navigator.locks.request when Web Locks is available", async () => {
    const request = vi.fn((_name: string, _options: { signal?: AbortSignal }, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal("navigator", { locks: { request } })

    await expect(withTabLock("lock-a", () => "done", { waitTimeoutMs: 1_000 })).resolves.toBe("done")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe("lock-a")
  })

  it("propagates a throw from operation run inside navigator.locks.request", async () => {
    const request = vi.fn((_name: string, _options: { signal?: AbortSignal }, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal("navigator", { locks: { request } })

    await expect(
      withTabLock(
        "lock-a",
        () => {
          throw new Error("boom")
        },
        { waitTimeoutMs: 1_000 },
      ),
    ).rejects.toThrow("boom")
  })

  it("passes a merged wait-phase signal (user signal + wait deadline) to navigator.locks.request", async () => {
    const request = vi.fn((_name: string, _options: { signal?: AbortSignal }, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal("navigator", { locks: { request } })
    const controller = new AbortController()

    await expect(withTabLock("lock-signal", () => "done", { signal: controller.signal, waitTimeoutMs: 1_000 })).resolves.toBe("done")
    expect(request).toHaveBeenCalledTimes(1)
    // The platform only accepts one signal; the user's and the wait timer's are merged into it.
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it("rejects with TimeoutError when operation doesn't settle within timeoutMs (Web Locks path)", async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_name: string, _options: { signal?: AbortSignal }, callback: () => Promise<unknown>) => callback())
      vi.stubGlobal("navigator", { locks: { request } })

      const promise = withTabLock("lock-hang", () => new Promise(() => {}), { timeoutMs: 100, waitTimeoutMs: 1_000 })
      const assertion = expect(promise).rejects.toMatchObject({ name: "TimeoutError" })
      await vi.advanceTimersByTimeAsync(100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("honors timeoutMs on the no-Web-Locks fallback path too", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("navigator", {})

      const promise = withTabLock("lock-timeout", () => new Promise(() => {}), { timeoutMs: 100, waitTimeoutMs: 1_000 })
      const assertion = expect(promise).rejects.toThrow(/timed out after 100ms/)
      await vi.advanceTimersByTimeAsync(100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("resolves normally when operation settles before timeoutMs", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("navigator", {})

      const promise = withTabLock(
        "lock-fast",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return "done"
        },
        { timeoutMs: 100, waitTimeoutMs: 1_000 },
      )
      await vi.advanceTimersByTimeAsync(50)
      await expect(promise).resolves.toBe("done")
      // The timer was cleared — advancing well past the deadline must not reject later.
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(promise).resolves.toBe("done")
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts ctx.timeoutSignal when timeoutMs expires, and leaves it alone otherwise", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("navigator", {})
      let seen: AbortSignal | undefined
      const promise = withTabLock(
        "lock-timeout-signal",
        (ctx) => {
          seen = ctx.timeoutSignal
          return new Promise(() => {})
        },
        { timeoutMs: 100, waitTimeoutMs: 1_000 },
      )
      const assertion = expect(promise).rejects.toMatchObject({ name: "TimeoutError" })
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(seen?.aborted).toBe(true)

      let settledSignal: AbortSignal | undefined
      await withTabLock(
        "lock-timeout-signal",
        (ctx) => {
          settledSignal = ctx.timeoutSignal
          return "done"
        },
        { timeoutMs: 100, waitTimeoutMs: 1_000 },
      )
      expect(settledSignal?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("options.signal aborts the wait for the lock with an AbortError, not the operation", async () => {
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void locks.request("lock-wait", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

    const controller = new AbortController()
    const waiting = withTabLock("lock-wait", () => "done", { signal: controller.signal, waitTimeoutMs: 10_000 })
    const assertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(locks.pendingCount("lock-wait")).toBe(1))
    controller.abort()
    await assertion
    releaseHolder()
  })

  it("options.signal aborting the wait preserves the caller's custom abort reason", async () => {
    // Regression: the wait-phase abort used to be a bare `.abort()` with no reason, so a
    // custom reason passed to the caller's own controller was silently dropped.
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void locks.request("lock-wait-reason", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

    const controller = new AbortController()
    const reason = new Error("cancelled by caller")
    const waiting = withTabLock("lock-wait-reason", () => "done", { signal: controller.signal, waitTimeoutMs: 10_000 })
    const assertion = expect(waiting).rejects.toBe(reason)
    await vi.waitFor(() => expect(locks.pendingCount("lock-wait-reason")).toBe(1))
    controller.abort(reason)
    await assertion
    releaseHolder()
  })

  it("options.signal already aborted before the call preserves the caller's custom abort reason", async () => {
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void locks.request("lock-preaborted-reason", () => new Promise<void>((resolve) => (releaseHolder = resolve)))
    await vi.waitFor(() => expect(locks.isHeld("lock-preaborted-reason")).toBe(true))

    const controller = new AbortController()
    const reason = new Error("cancelled before call")
    controller.abort(reason)
    await expect(withTabLock("lock-preaborted-reason", () => "done", { signal: controller.signal, waitTimeoutMs: 10_000 })).rejects.toBe(
      reason,
    )
    releaseHolder()
  })

  it("options.signal and ctx.timeoutSignal are independent signals", async () => {
    const locks = installFakeLocks()
    const controller = new AbortController()
    await expect(
      withTabLock(
        "lock-two-signals",
        (ctx) => {
          // Aborting the wait-phase signal mid-operation must not abort timeoutSignal —
          // the two have different lifecycles and triggers.
          controller.abort()
          expect(ctx.timeoutSignal.aborted).toBe(false)
          return "done"
        },
        { signal: controller.signal, timeoutMs: 10_000, waitTimeoutMs: 10_000 },
      ),
    ).resolves.toBe("done")
    expect(locks.isHeld("lock-two-signals")).toBe(false)
  })

  it("rejects with a TimeoutError naming the lock when the wait exceeds waitTimeoutMs", async () => {
    vi.useFakeTimers()
    try {
      const locks = installFakeLocks()
      let releaseHolder!: () => void
      void locks.request("lock-slow", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

      const waiting = withTabLock("lock-slow", () => "done", { waitTimeoutMs: 100 })
      const assertion = expect(waiting).rejects.toMatchObject({ name: "TimeoutError" })
      const message = expect(waiting).rejects.toThrow('timed out waiting 100ms for tab lock "lock-slow"')
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      await message
      expect(locks.pendingCount("lock-slow")).toBe(0) // the waiter left the queue
      releaseHolder()
    } finally {
      vi.useRealTimers()
    }
  })

  it("waitTimeoutMs: Infinity waits without a bound", async () => {
    vi.useFakeTimers()
    try {
      const locks = installFakeLocks()
      let releaseHolder!: () => void
      void locks.request("lock-forever", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

      let settled = false
      const waiting = withTabLock("lock-forever", () => "done", { waitTimeoutMs: Infinity }).then((value) => {
        settled = true
        return value
      })
      await vi.advanceTimersByTimeAsync(60_000) // far past any sane deadline — still waiting
      expect(settled).toBe(false)

      releaseHolder()
      await expect(waiting).resolves.toBe("done")
    } finally {
      vi.useRealTimers()
    }
  })

  it("waitTimeoutMs beyond setTimeout's 32-bit delay limit still waits the full duration", async () => {
    // Regression: a delay beyond ~24.8 days (2^31-1 ms) overflows setTimeout's 32-bit signed
    // int and used to fire almost immediately instead of waiting the requested duration.
    vi.useFakeTimers()
    try {
      const locks = installFakeLocks()
      let releaseHolder!: () => void
      void locks.request("lock-huge-wait", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

      const hugeWaitMs = 3_000_000_000 // ~34.7 days, past the 2^31-1 ms setTimeout limit
      const waiting = withTabLock("lock-huge-wait", () => "done", { waitTimeoutMs: hugeWaitMs })
      const assertion = expect(waiting).rejects.toMatchObject({ name: "TimeoutError" })
      let settled = false
      void waiting.catch(() => undefined).finally(() => (settled = true))

      await vi.advanceTimersByTimeAsync(2_147_483_647) // the largest single delay setTimeout accepts
      expect(settled).toBe(false) // must not have fired early from the overflowed chunk

      await vi.advanceTimersByTimeAsync(hugeWaitMs - 2_147_483_647)
      await assertion
      expect(settled).toBe(true)
      releaseHolder()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a wait that times out while this tab holds the same lock names the nested-call deadlock", async () => {
    vi.useFakeTimers()
    try {
      installFakeLocks()
      // Web Locks are not re-entrant: the inner call can only ever time out — and the error
      // should say why, instead of leaving a mysterious stall.
      const outer = withTabLock(
        "lock-nested",
        async () => {
          const inner = withTabLock("lock-nested", () => "inner", { waitTimeoutMs: 100 })
          const name = expect(inner).rejects.toMatchObject({ name: "TimeoutError" })
          const hint = expect(inner).rejects.toThrow(/nested same-name withTabLock call deadlocks/)
          await vi.advanceTimersByTimeAsync(100)
          await name
          await hint
          return "outer"
        },
        { waitTimeoutMs: 10_000 },
      )
      await expect(outer).resolves.toBe("outer")
    } finally {
      vi.useRealTimers()
    }
  })

  it("throws RangeError synchronously on an invalid waitTimeoutMs or timeoutMs", () => {
    vi.stubGlobal("navigator", {})
    for (const bad of [0, -1, NaN]) {
      expect(() => withTabLock("lock-bad", () => 1, { waitTimeoutMs: bad })).toThrow(RangeError)
      expect(() => withTabLock("lock-bad", () => 1, { waitTimeoutMs: 1_000, timeoutMs: bad })).toThrow(RangeError)
    }
    // Infinity is the explicit "wait without a bound" spelling — valid for the wait, but
    // meaningless (and so rejected) as an operation timeout.
    expect(() => withTabLock("lock-bad", () => 1, { waitTimeoutMs: 1_000, timeoutMs: Infinity })).toThrow(RangeError)
    expect(() => withTabLock("lock-bad", () => 1, { waitTimeoutMs: Infinity })).not.toThrow()
  })
})

describe("tryWithTabLock", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports acquired and runs the operation on the no-Web-Locks fallback path", async () => {
    vi.stubGlobal("navigator", {})
    // With no lock to contend for, "skip" has no meaning — the operation runs.
    await expect(tryWithTabLock("try-fallback", () => "done")).resolves.toEqual({ acquired: true, value: "done" })
  })

  it("propagates a throw from operation on the fallback path", async () => {
    vi.stubGlobal("navigator", {})
    await expect(
      tryWithTabLock("try-fallback-throw", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })

  it("runs the operation and reports acquired when the lock is free", async () => {
    installFakeLocks()
    const operation = vi.fn(() => "done")
    await expect(tryWithTabLock("try-free", operation)).resolves.toEqual({ acquired: true, value: "done" })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it("skips the operation and reports not-acquired when another tab holds the lock", async () => {
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void locks.request("try-held", () => new Promise<void>((resolve) => (releaseHolder = resolve)))
    await vi.waitFor(() => expect(locks.isHeld("try-held")).toBe(true))

    const operation = vi.fn(() => "done")
    await expect(tryWithTabLock("try-held", operation)).resolves.toEqual({ acquired: false })
    expect(operation).not.toHaveBeenCalled()
    releaseHolder()
  })

  it("honors timeoutMs and aborts ctx.timeoutSignal on the locked path", async () => {
    vi.useFakeTimers()
    try {
      installFakeLocks()
      let seen: AbortSignal | undefined
      const promise = tryWithTabLock(
        "try-timeout",
        (ctx) => {
          seen = ctx.timeoutSignal
          return new Promise(() => {})
        },
        { timeoutMs: 100 },
      )
      const assertion = expect(promise).rejects.toMatchObject({ name: "TimeoutError" })
      await vi.advanceTimersByTimeAsync(100)
      await assertion
      expect(seen?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("throws RangeError synchronously on an invalid timeoutMs", () => {
    expect(() => tryWithTabLock("try-bad", () => 1, { timeoutMs: 0 })).toThrow(RangeError)
    expect(() => tryWithTabLock("try-bad", () => 1, { timeoutMs: NaN })).toThrow(RangeError)
  })

  it("accepts options.signal without violating Web Locks' ifAvailable+signal restriction", async () => {
    // Regression: the real Web Locks API throws a TypeError if `signal` is combined with
    // `ifAvailable` on the same request — tryWithTabLock must not forward `signal` that way.
    installFakeLocks()
    const controller = new AbortController()
    await expect(tryWithTabLock("try-signal", () => "done", { signal: controller.signal })).resolves.toEqual({
      acquired: true,
      value: "done",
    })
  })

  it("rejects immediately with the signal's reason when already aborted", async () => {
    installFakeLocks()
    const controller = new AbortController()
    const reason = new Error("cancelled by caller")
    controller.abort(reason)
    const operation = vi.fn(() => "done")
    await expect(tryWithTabLock("try-preaborted", operation, { signal: controller.signal })).rejects.toBe(reason)
    expect(operation).not.toHaveBeenCalled()
  })
})
