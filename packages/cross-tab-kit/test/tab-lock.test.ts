import { afterEach, describe, expect, it, vi } from "vitest"
import { tryWithTabLock, withTabLock } from "../src/locks/tab-lock"
import { installFakeLocks } from "./harness/fake-locks"

describe("withTabLock", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("runs operation and returns its result when Web Locks isn't available", async () => {
    vi.stubGlobal("navigator", {})
    await expect(withTabLock("lock-a", () => "done")).resolves.toBe("done")
  })

  it("runs a synchronous operation without Web Locks", async () => {
    vi.stubGlobal("navigator", {})
    const operation = vi.fn(() => 42)
    await expect(withTabLock("lock-a", operation)).resolves.toBe(42)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it("propagates a throw from operation without Web Locks", async () => {
    vi.stubGlobal("navigator", {})
    await expect(
      withTabLock("lock-a", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })

  it("runs operation inside navigator.locks.request when Web Locks is available", async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal("navigator", { locks: { request } })

    await expect(withTabLock("lock-a", () => "done")).resolves.toBe("done")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe("lock-a")
  })

  it("propagates a throw from operation run inside navigator.locks.request", async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal("navigator", { locks: { request } })

    await expect(
      withTabLock("lock-a", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })

  it("forwards signal to navigator.locks.request", async () => {
    const request = vi.fn((_name: string, _options: { signal?: AbortSignal }, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal("navigator", { locks: { request } })
    const controller = new AbortController()

    await expect(withTabLock("lock-signal", () => "done", { signal: controller.signal })).resolves.toBe("done")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe("lock-signal")
    expect(request.mock.calls[0]?.[1]).toEqual({ signal: controller.signal })
  })

  it("rejects with TimeoutError when operation doesn't settle within timeoutMs (Web Locks path)", async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback())
      vi.stubGlobal("navigator", { locks: { request } })

      const promise = withTabLock("lock-hang", () => new Promise(() => {}), { timeoutMs: 100 })
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

      const promise = withTabLock("lock-timeout", () => new Promise(() => {}), { timeoutMs: 100 })
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
        { timeoutMs: 100 },
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
        { timeoutMs: 100 },
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
        { timeoutMs: 100 },
      )
      expect(settledSignal?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("options.signal aborts the wait for the lock, not the operation", async () => {
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void locks.request("lock-wait", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

    const controller = new AbortController()
    const waiting = withTabLock("lock-wait", () => "done", { signal: controller.signal })
    const assertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(locks.pendingCount("lock-wait")).toBe(1))
    controller.abort()
    await assertion
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
        { signal: controller.signal, timeoutMs: 10_000 },
      ),
    ).resolves.toBe("done")
    expect(locks.isHeld("lock-two-signals")).toBe(false)
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
})
