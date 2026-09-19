import { afterEach, describe, expect, it, vi } from "vitest"
import { withTabLock } from "../src/tab-lock"

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
})
