import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTtlDedupeCache } from "../src/primitives/ttl-dedupe"

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

  it("warns via a custom logger on an invalid ttlMs", () => {
    const warn = vi.fn()

    createTtlDedupeCache("dedupe-ttl-zero", 0, { logger: { warn } })
    createTtlDedupeCache("dedupe-ttl-inf", Infinity, { logger: { warn } })

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain("ttlMs")
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
  it("still returns true when the write fails (fail-open)", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      const cache = createTtlDedupeCache("dedupe-write-fail", 60_000)
      // The claim can't persist, so cross-tab dedupe is lost — but the call still reports
      // the claim rather than throwing or hanging the caller.
      expect(cache.claim("a")).toBe(true)
    } finally {
      setItemSpy.mockRestore()
    }
  })
})

describe("TtlDedupeCache.has", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("reports membership without claiming", () => {
    const cache = createTtlDedupeCache("dedupe-has", 60_000)

    expect(cache.has("a")).toBe(false)
    expect(cache.claim("a")).toBe(true)
    expect(cache.has("a")).toBe(true)
    // Querying is not claiming: a has() doesn't start the id's window.
    expect(cache.has("b")).toBe(false)
    expect(cache.claim("b")).toBe(true)
  })

  it("is side-effect free: it never writes to storage", () => {
    const cache = createTtlDedupeCache("dedupe-has-pure", 60_000)
    cache.claim("a")

    const spy = vi.spyOn(Storage.prototype, "setItem")
    try {
      expect(cache.has("a")).toBe(true)
      expect(cache.has("missing")).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("reports false once the TTL window has passed", () => {
    vi.useFakeTimers()
    try {
      const cache = createTtlDedupeCache("dedupe-has-ttl", 60_000)
      cache.claim("a")
      expect(cache.has("a")).toBe(true)

      vi.advanceTimersByTime(60_000)

      expect(cache.has("a")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("TtlDedupeCache maxEntries", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("evicts the oldest-claimed entry once a claim would exceed maxEntries", () => {
    vi.useFakeTimers()
    try {
      const cache = createTtlDedupeCache("dedupe-bound", 60_000, { maxEntries: 2 })

      expect(cache.claim("a")).toBe(true)
      vi.advanceTimersByTime(10)
      expect(cache.claim("b")).toBe(true)
      vi.advanceTimersByTime(10)
      expect(cache.claim("c")).toBe(true)

      expect(cache.has("a")).toBe(false) // oldest — evicted
      expect(cache.has("b")).toBe(true)
      expect(cache.has("c")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("evicts the just-expired entries before the live ones", () => {
    vi.useFakeTimers()
    try {
      const cache = createTtlDedupeCache("dedupe-bound-ttl", 1_000, { maxEntries: 1 })

      expect(cache.claim("a")).toBe(true)
      vi.advanceTimersByTime(1_000) // a's window lapses
      expect(cache.claim("b")).toBe(true)

      expect(cache.has("a")).toBe(false)
      expect(cache.has("b")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a repeat claim within the window evicts nothing", () => {
    const cache = createTtlDedupeCache("dedupe-bound-repeat", 60_000, { maxEntries: 1 })

    expect(cache.claim("a")).toBe(true)
    expect(cache.claim("a")).toBe(false)
    expect(cache.has("a")).toBe(true)
  })

  it("ignores an unusable maxEntries and stays unbounded", () => {
    const cache = createTtlDedupeCache("dedupe-bound-invalid", 60_000, { maxEntries: 0 })

    for (let i = 0; i < 5; i++) expect(cache.claim(`id-${i}`)).toBe(true)
    for (let i = 0; i < 5; i++) expect(cache.has(`id-${i}`)).toBe(true)
  })
})
