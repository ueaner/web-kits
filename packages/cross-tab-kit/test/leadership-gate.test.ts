import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLeadershipGate, TENURE_RELEASED_REASON } from "../src/patterns/leadership-gate"
import { installFakeLocks } from "./harness/fake-locks"
import { createTabWorld, flushMicrotasks } from "./harness/tabs"

describe("createLeadershipGate", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("acquires a tenure when the lease is free, and renews it on re-acquire", async () => {
    const gate = createLeadershipGate("gate-basic", 10_000)

    const tenure = await gate.acquire()
    expect(tenure).not.toBeNull()
    expect(tenure?.fence).toBe(1)
    expect(tenure?.signal.aborted).toBe(false)

    // A renewal is the same tenure — same object, same fence, same signal.
    await expect(gate.acquire()).resolves.toBe(tenure)
  })

  it("returns null while another owner holds the lease, and acquires after a release", async () => {
    const gateA = createLeadershipGate("gate-contended", 10_000)
    const gateB = createLeadershipGate("gate-contended", 10_000)

    expect(await gateA.acquire()).not.toBeNull()
    expect(await gateB.acquire()).toBeNull()

    gateA.release()
    const tenureB = await gateB.acquire()
    expect(tenureB?.fence).toBe(2)
  })

  it("release() aborts the tenure signal immediately; the tombstone lands on a later microtask", async () => {
    const gate = createLeadershipGate("gate-release", 10_000)
    const tenure = await gate.acquire()

    gate.release()

    // The abort is synchronous and marks the tenure as deliberately released; the tombstone
    // write is serialized through the same lock as claims and lands asynchronously.
    expect(tenure?.signal.aborted).toBe(true)
    expect(tenure?.signal.reason).toBe(TENURE_RELEASED_REASON)

    await flushMicrotasks()
    const stored = JSON.parse(localStorage.getItem("gate-release")!) as { ownerId: string; fence: number; expiresAt: number }
    expect(stored.expiresAt).toBe(0) // tombstone, not removal — the fence survives
    expect(stored.fence).toBe(1)
  })

  it("isStillValid re-claims under the lock and renews the lease", async () => {
    const world = createTabWorld()
    try {
      const gate = createLeadershipGate("gate-renew", 1_000)
      const gateB = createLeadershipGate("gate-renew", 1_000)
      const tenure = await gate.acquire()

      await world.advance(900)
      // Would have expired without the renewal isStillValid performs.
      await expect(tenure?.isStillValid()).resolves.toBe(true)
      expect(await gateB.acquire()).toBeNull()
      await world.advance(1_100) // past the renewed expiry
      expect(await gateB.acquire()).not.toBeNull() // no further renewal — B takes over
    } finally {
      world.cleanup()
    }
  })

  it("aborts the tenure signal when a storage event shows the lease changing hands", async () => {
    const gate = createLeadershipGate("gate-stolen", 10_000)
    const tenure = await gate.acquire()

    const thiefRecord = JSON.stringify({ ownerId: "someone-else", fence: 2, expiresAt: Date.now() + 10_000 })
    window.dispatchEvent(new StorageEvent("storage", { key: "gate-stolen", newValue: thiefRecord, storageArea: localStorage }))

    expect(tenure?.signal.aborted).toBe(true)
  })

  it("ignores storage events for other keys, unparseable values, and its own writes", async () => {
    const gate = createLeadershipGate("gate-events", 10_000)
    const tenure = await gate.acquire()

    window.dispatchEvent(new StorageEvent("storage", { key: "gate-events:other", newValue: "{}", storageArea: localStorage }))
    window.dispatchEvent(new StorageEvent("storage", { key: "gate-events", newValue: "not json {{{", storageArea: localStorage }))
    // A record still naming this gate's owner is not a loss — only "now someone else's" is.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "gate-events",
        newValue: localStorage.getItem("gate-events"),
        storageArea: localStorage,
      }),
    )

    expect(tenure?.signal.aborted).toBe(false)
  })

  it("aborts the tenure when the lease record is removed or storage is cleared", async () => {
    const world = createTabWorld()
    try {
      const gateA = createLeadershipGate("gate-removed", 10_000)
      const tenureA = await gateA.acquire()
      // removeItem fires the event with newValue === null: the record is gone — conservatively
      // end the tenure; the next acquire() reclaims cleanly.
      world.fireStorageEvent("gate-removed", null)
      expect(tenureA?.signal.aborted).toBe(true)

      const gateB = createLeadershipGate("gate-cleared", 10_000)
      const tenureB = await gateB.acquire()
      // localStorage.clear() fires with key === null: it wiped the record and reset the fence —
      // exactly the "fence must never be forgotten" scenario the tombstone exists to prevent.
      world.fireStorageEvent(null, null)
      expect(tenureB?.signal.aborted).toBe(true)
    } finally {
      world.cleanup()
    }
  })

  it("release()'s tombstone write is ordered through the lock — it cannot land while the mutex is held elsewhere", async () => {
    const locks = installFakeLocks()
    const gate = createLeadershipGate("gate-release-order", 10_000, { lockName: "gate-release-order:mutex" })
    const tenure = await gate.acquire()

    // An external holder parks on the mutex: anything the gate routes through the lock must queue.
    let releaseHolder!: () => void
    void locks.request("gate-release-order:mutex", () => new Promise<void>((resolve) => (releaseHolder = resolve)))
    await vi.waitFor(() => expect(locks.isHeld("gate-release-order:mutex")).toBe(true))

    gate.release()
    // The abort is synchronous, but the tombstone write is queued behind the held lock: the
    // stored lease must still be the live record. A bare (unlocked) write would fail this.
    expect(tenure?.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(locks.pendingCount("gate-release-order:mutex")).toBe(1))
    let stored = JSON.parse(localStorage.getItem("gate-release-order")!) as { fence: number; expiresAt: number }
    expect(stored.expiresAt).not.toBe(0)

    // A rival's claim queues *behind* the tombstone write (same-name FIFO), so its read can
    // never see the pre-release lease and overwrite it with a stale-fence record.
    const rival = createLeadershipGate("gate-release-order", 10_000, { lockName: "gate-release-order:mutex" })
    const rivalPending = rival.acquire()
    await vi.waitFor(() => expect(locks.pendingCount("gate-release-order:mutex")).toBe(2))

    releaseHolder()
    // Once the holder steps aside: tombstone lands first (fence preserved at 1), then the
    // rival's claim reads it and takes over with fence + 1.
    const rivalTenure = await rivalPending
    expect(rivalTenure?.fence).toBe(2)
    stored = JSON.parse(localStorage.getItem("gate-release-order")!) as { fence: number; expiresAt: number }
    expect(stored.fence).toBe(2)
  })

  it("stops listening after release", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const gate = createLeadershipGate("gate-unlisten", 10_000)
    await gate.acquire()
    gate.release()

    expect(removeSpy).toHaveBeenCalledWith("storage", expect.any(Function))
  })

  it("serializes claims through a named Web Locks mutex when available", async () => {
    const locks = installFakeLocks()
    const gate = createLeadershipGate("gate-locked", 10_000, { lockName: "gate-locked:mutex" })

    let releaseHolder!: () => void
    void locks.request("gate-locked:mutex", () => new Promise<void>((resolve) => (releaseHolder = resolve)))
    await vi.waitFor(() => expect(locks.isHeld("gate-locked:mutex")).toBe(true))

    let settled = false
    const pending = gate.acquire().then((tenure) => {
      settled = true
      return tenure
    })
    await vi.waitFor(() => expect(locks.pendingCount("gate-locked:mutex")).toBe(1))
    expect(settled).toBe(false)

    releaseHolder()
    await expect(pending).resolves.not.toBeNull()
  })

  it("still works with no window (storage-event listening is skipped)", async () => {
    vi.stubGlobal("window", undefined)
    const gate = createLeadershipGate("gate-no-window", 10_000)

    const tenure = await gate.acquire()
    expect(tenure).not.toBeNull()
    await expect(tenure?.isStillValid()).resolves.toBe(true)
    expect(() => gate.release()).not.toThrow()
  })

  it("warns on an invalid ttlMs through the injected logger", () => {
    const warn = vi.fn()
    createLeadershipGate("gate-bad-ttl", 0, { logger: { warn } })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("ttlMs")
  })
})
