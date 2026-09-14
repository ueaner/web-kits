import { beforeEach, describe, expect, it } from "vitest"
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
})
