import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPollLeaseClaimer, generatePollOwnerId } from "../src/primitives/poll-lease"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("createPollLeaseClaimer", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("lets the first owner claim an unheld lease", () => {
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
  })

  it("lets the same owner renew its own still-valid lease repeatedly, keeping the same fence", () => {
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
  })

  it("refuses a different owner while the lease is still valid", () => {
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
    expect(lease.claim("owner-b")).toEqual({ leader: false })
  })

  it("lets a different owner claim the lease once it expires, bumping the fence", async () => {
    const lease = createPollLeaseClaimer("test-lease", 10)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
    await sleep(20)
    expect(lease.claim("owner-b")).toEqual({ leader: true, fence: 2 })
  })

  it("bumps the fence when the same owner reclaims its own already-expired lease", async () => {
    const lease = createPollLeaseClaimer("test-lease", 10)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
    await sleep(20)
    // Even though it's the same owner id, this is a fresh tenure, not a renewal of the one that
    // just lapsed — another tab could have claimed and released it in the meantime, so the fence
    // must move on rather than silently look identical to an uninterrupted renewal.
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 2 })
  })

  it("release() only clears a lease the caller currently owns", () => {
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    lease.claim("owner-a")

    lease.release("owner-b") // not the current owner — must be a no-op
    expect(lease.claim("owner-b")).toEqual({ leader: false }) // owner-a's lease is still valid

    lease.release("owner-a")
    expect(lease.claim("owner-b")).toEqual({ leader: true, fence: 2 }) // now free
  })

  it("keeps the fence strictly increasing across a release, so it can't collide with a fence captured before the release", () => {
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
    lease.release("owner-a")
    expect(lease.claim("owner-b")).toEqual({ leader: true, fence: 2 })
    lease.release("owner-b")
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 3 })
  })

  it("still reports leader:true when the underlying localStorage write silently fails", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    const lease = createPollLeaseClaimer("test-lease", 10_000)
    // Fails open rather than reporting the claim as lost — see writeLease's doc comment.
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })

    setItemSpy.mockRestore()
  })

  it("tolerates garbage already sitting in localStorage under the same key", () => {
    localStorage.setItem("test-lease", "not json")
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })
  })

  it("treats a lease record missing a fence (e.g. from an older version) as unreadable garbage", () => {
    localStorage.setItem("test-lease", JSON.stringify({ ownerId: "owner-a", expiresAt: Date.now() + 10_000 }))
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    // Falls back to treating the lease as unheld rather than trusting a malformed record.
    expect(lease.claim("owner-b")).toEqual({ leader: true, fence: 1 })
  })

  it("treats a lease record with non-finite numbers (e.g. 1e999 → Infinity) as unreadable garbage", () => {
    // Written as a raw JSON string: JSON.stringify would serialize Infinity as null, but an
    // out-of-range literal in hand-edited storage parses to Infinity — the case under test.
    localStorage.setItem("test-lease", '{"ownerId":"owner-a","fence":1,"expiresAt":1e999}')
    const lease = createPollLeaseClaimer("test-lease", 10_000)
    // An Infinity expiresAt could never lapse — accepting the record would block takeover forever.
    expect(lease.claim("owner-b")).toEqual({ leader: true, fence: 1 })
  })

  it("warns on a NaN or infinite ttlMs, which would silently break election", () => {
    const warn = vi.fn()

    createPollLeaseClaimer("test-lease-nan", NaN, { logger: { warn } })
    createPollLeaseClaimer("test-lease-inf", Infinity, { logger: { warn } })

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain("ttlMs")
  })

  it("treats a throwing localStorage read as 'no lease' (read failure degrades to unheld)", () => {
    // A valid lease owned by someone else is sitting in storage — but reads throw, so this
    // tab is blind to it. The claim fails open (reports leader) rather than blocking forever.
    localStorage.setItem("test-lease-read-fail", JSON.stringify({ ownerId: "owner-x", fence: 5, expiresAt: Date.now() + 10_000 }))
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })

    const lease = createPollLeaseClaimer("test-lease-read-fail", 10_000)
    expect(lease.claim("owner-a")).toEqual({ leader: true, fence: 1 })

    getItemSpy.mockRestore()
  })

  it("release() doesn't throw when the tombstone write fails", () => {
    const lease = createPollLeaseClaimer("test-lease-release-fail", 10_000)
    lease.claim("owner-a")
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    expect(() => lease.release("owner-a")).not.toThrow()

    setItemSpy.mockRestore()
  })

  it("two independent claimers on different storage keys don't contend with each other", () => {
    const leaseA = createPollLeaseClaimer("lease-a", 10_000)
    const leaseB = createPollLeaseClaimer("lease-b", 10_000)
    expect(leaseA.claim("owner-1")).toEqual({ leader: true, fence: 1 })
    expect(leaseB.claim("owner-2")).toEqual({ leader: true, fence: 1 })
  })

  it("routes the non-positive ttlMs warning through a custom logger instead of console", () => {
    const warn = vi.fn()
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    createPollLeaseClaimer("test-lease-bad-ttl", 0, { logger: { warn } })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("ttlMs")
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })

  it("warns via console by default on a non-positive ttlMs", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    createPollLeaseClaimer("test-lease-bad-ttl-default", -1)

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain("ttlMs")
    consoleWarnSpy.mockRestore()
  })

  it("a throwing logger doesn't break claimer creation on a non-positive ttlMs", () => {
    expect(() =>
      createPollLeaseClaimer("test-lease-throwing-logger", 0, {
        logger: {
          warn: () => {
            throw new Error("telemetry is down")
          },
        },
      }),
    ).not.toThrow()
  })
})

describe("generatePollOwnerId", () => {
  it("returns a non-empty string", () => {
    const id = generatePollOwnerId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  it("returns a different id on every call", () => {
    expect(generatePollOwnerId()).not.toBe(generatePollOwnerId())
  })
})
