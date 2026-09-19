import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTtlDedupeCache } from "../src/ttl-dedupe-cache"

describe("createTtlDedupeCache", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("claims an id once and rejects repeats within the TTL window", () => {
    const cache = createTtlDedupeCache("dedupe-basic", 60_000)

    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("a")).toBe(false)
    expect(cache.claim("b")).toBe(true)
  })

  it("claims an id that collides with an inherited Object.prototype property name", () => {
    const cache = createTtlDedupeCache("dedupe-prototype", 60_000)

    expect(cache.claim("constructor")).toBe(true)
    expect(cache.claim("constructor")).toBe(false)
    expect(cache.claim("__proto__")).toBe(true)
    expect(cache.claim("toString")).toBe(true)
  })

  it("clear() wipes every claim, letting a previously-claimed id be claimed again", () => {
    const cache = createTtlDedupeCache("dedupe-clear", 60_000)

    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("a")).toBe(false)

    cache.clear()

    expect(cache.claim("a")).toBe(true)
  })

  it("lets an id be claimed again once the TTL window has passed", () => {
    vi.useFakeTimers()
    try {
      const cache = createTtlDedupeCache("dedupe-ttl", 60_000)

      expect(cache.claim("a")).toBe(true)
      expect(cache.claim("a")).toBe(false)

      vi.advanceTimersByTime(60_000)

      expect(cache.claim("a")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("treats corrupted stored state as empty instead of throwing", () => {
    localStorage.setItem("dedupe-corrupt", "not json {{{")
    const cache = createTtlDedupeCache("dedupe-corrupt", 60_000)

    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("a")).toBe(false)
  })

  it("treats malformed entries (null, non-numeric claimedAt) as already expired", () => {
    localStorage.setItem("dedupe-malformed", JSON.stringify({ a: null, b: { claimedAt: "oops" } }))
    const cache = createTtlDedupeCache("dedupe-malformed", 60_000)

    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("b")).toBe(true)
  })

  it("doesn't rewrite storage on a repeat claim when nothing expired", () => {
    const cache = createTtlDedupeCache("dedupe-no-rewrite", 60_000)
    cache.claim("a")

    const spy = vi.spyOn(Storage.prototype, "setItem")
    try {
      expect(cache.claim("a")).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("persists pruning when a repeat claim finds expired entries", () => {
    vi.useFakeTimers()
    try {
      const cache = createTtlDedupeCache("dedupe-prune", 60_000)
      cache.claim("stale")
      vi.advanceTimersByTime(30_000)
      cache.claim("a")
      vi.advanceTimersByTime(30_000)

      const spy = vi.spyOn(Storage.prototype, "setItem")
      try {
        expect(cache.claim("a")).toBe(false)
        expect(spy).toHaveBeenCalledTimes(1)
        const stored = JSON.parse(localStorage.getItem("dedupe-prune")!) as Record<string, unknown>
        expect(stored).not.toHaveProperty("stale")
        expect(stored).toHaveProperty("a")
      } finally {
        spy.mockRestore()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
