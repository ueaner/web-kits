import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LeadershipContext } from "../src/patterns/leadership-loop"
import { createLeadershipLoop } from "../src/patterns/leadership-loop"
import { createLeadershipGate } from "../src/patterns/leadership-gate"
import { createTabWorld, type TabWorld } from "./harness/tabs"
import { installFakeLocks } from "./harness/fake-locks"

describe("createLeadershipLoop", () => {
  let world: TabWorld

  beforeEach(() => {
    // These tests use ttlMs 900ms throughout, which intentionally sits in the gate's
    // sub-second-TTL warn zone — silence the expected console.warn to keep output readable.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    world.cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("claims leadership immediately and invokes onLeadership once per tenure", async () => {
    world = createTabWorld()
    const seen: number[] = []
    createLeadershipLoop("loop-basic", 900, (ctx) => {
      seen.push(ctx.fence)
    })

    await world.flush()
    expect(seen).toEqual([1])

    // Renewals (every ttlMs/3 = 300ms) keep the same tenure — no repeat invocation.
    await world.advance(1_200)
    expect(seen).toEqual([1])
  })

  it("renews on the interval, keeping another loop out for as long as it renews", async () => {
    world = createTabWorld()
    const onA = vi.fn()
    const onB = vi.fn()
    createLeadershipLoop("loop-contended", 900, onA)
    await world.flush()

    createLeadershipLoop("loop-contended", 900, onB)
    await world.advance(3_000)

    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it("takes over when the holder freezes and the lease lapses (TTL self-heal)", async () => {
    world = createTabWorld()
    // A gate nobody re-acquires simulates a frozen/crashed holder: it claims once and
    // never renews, sends no release — exactly what pagehide-less death looks like.
    const frozenHolder = createLeadershipGate("loop-takeover", 900)
    await frozenHolder.acquire()

    const onB = vi.fn()
    createLeadershipLoop("loop-takeover", 900, onB)
    await world.advance(300)
    expect(onB).not.toHaveBeenCalled() // the frozen holder's lease is still valid

    await world.advance(900) // past the TTL: the next tick claims the lapsed lease
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onB.mock.calls[0]?.[0]?.fence).toBe(2)
  })

  it("aborts the context signal before onLeadershipLost when the lease is stolen", async () => {
    world = createTabWorld()
    const order: string[] = []
    let ctxA: LeadershipContext | undefined
    createLeadershipLoop(
      "loop-stolen",
      900,
      (ctx) => {
        ctxA = ctx
      },
      {
        onLeadershipLost: () => order.push(ctxA?.signal.aborted ? "aborted-then-lost" : "lost-before-abort"),
      },
    )
    await world.flush()

    // Another tab claims: it writes the lease, and that write's storage event is what
    // notifies this tab — loss detection at write time, not at the next renewal tick.
    localStorage.setItem("loop-stolen", JSON.stringify({ ownerId: "thief", fence: 2, expiresAt: Date.now() + 900 }))
    world.fireStorageEventFromStorage("loop-stolen")

    expect(ctxA?.signal.aborted).toBe(true)
    expect(order).toEqual(["aborted-then-lost"])
    await expect(ctxA?.isStillLeader()).resolves.toBe(false)
  })

  it("regains leadership after losing it, firing onLeadership again with a new fence", async () => {
    world = createTabWorld()
    const seen: number[] = []
    const lost = vi.fn()
    createLeadershipLoop(
      "loop-regain",
      900,
      (ctx) => {
        seen.push(ctx.fence)
      },
      { onLeadershipLost: lost },
    )
    await world.flush()
    expect(seen).toEqual([1])

    localStorage.setItem("loop-regain", JSON.stringify({ ownerId: "thief", fence: 2, expiresAt: Date.now() + 900 }))
    world.fireStorageEventFromStorage("loop-regain")
    expect(lost).toHaveBeenCalledTimes(1)

    await world.advance(1_200) // the thief's lease lapses; the next tick reclaims
    expect(seen).toEqual([1, 3])
  })

  it("stop() is idempotent, silent, and releases the lease", async () => {
    world = createTabWorld()
    const onLeadership = vi.fn()
    const onLeadershipLost = vi.fn()
    const stop = createLeadershipLoop("loop-stop", 900, onLeadership, { onLeadershipLost })
    await world.flush()
    expect(onLeadership).toHaveBeenCalledTimes(1)

    stop()
    stop()

    // A shutdown is not a loss, and nothing fires after stop().
    expect(onLeadershipLost).not.toHaveBeenCalled()
    // The tombstone write lands on a later microtask — flush before reading storage.
    await world.flush()
    const stored = JSON.parse(localStorage.getItem("loop-stop")!) as { expiresAt: number }
    expect(stored.expiresAt).toBe(0)

    await world.advance(5_000)
    expect(onLeadership).toHaveBeenCalledTimes(1)
    // The lease stayed released: another loop claims immediately, no TTL wait.
    const onB = vi.fn()
    createLeadershipLoop("loop-stop", 900, onB)
    await world.flush()
    expect(onB).toHaveBeenCalledTimes(1)
  })

  it("releases on pagehide by default, and doesn't when releaseOnExit is false", async () => {
    world = createTabWorld()
    createLeadershipLoop("loop-exit", 900, () => {})
    await world.flush()

    window.dispatchEvent(new Event("pagehide"))
    await world.flush() // the tombstone write lands on a later microtask
    let stored = JSON.parse(localStorage.getItem("loop-exit")!) as { expiresAt: number }
    expect(stored.expiresAt).toBe(0)

    createLeadershipLoop("loop-no-exit", 900, () => {}, { releaseOnExit: false })
    await world.flush()
    window.dispatchEvent(new Event("pagehide"))
    stored = JSON.parse(localStorage.getItem("loop-no-exit")!) as { expiresAt: number }
    expect(stored.expiresAt).toBeGreaterThan(Date.now())
  })

  it("unregisters the pagehide listener on stop", async () => {
    world = createTabWorld()
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const stop = createLeadershipLoop("loop-unlisten", 900, () => {})
    await world.flush()
    stop()

    expect(removeSpy).toHaveBeenCalledWith("pagehide", expect.any(Function))
    removeSpy.mockRestore()
  })

  it("does not call onLeadershipLost for the pagehide release — a deliberate shutdown is not a loss", async () => {
    world = createTabWorld()
    const onLeadershipLost = vi.fn()
    createLeadershipLoop("loop-exit-silent", 900, () => {}, { onLeadershipLost })
    await world.flush()

    window.dispatchEvent(new Event("pagehide"))
    await world.flush()

    expect(onLeadershipLost).not.toHaveBeenCalled()
    // ...but the release itself still landed.
    const stored = JSON.parse(localStorage.getItem("loop-exit-silent")!) as { expiresAt: number }
    expect(stored.expiresAt).toBe(0)
  })

  it("detects a missed storage event at the next renewal tick: fence moved → abort + onLeadershipLost", async () => {
    world = createTabWorld()
    const order: string[] = []
    let ctxA: LeadershipContext | undefined
    createLeadershipLoop(
      "loop-missed-event",
      900,
      (ctx) => {
        ctxA = ctx
      },
      {
        onLeadershipLost: () => order.push(ctxA?.signal.aborted ? "aborted-then-lost" : "lost-before-abort"),
      },
    )
    await world.flush()
    expect(ctxA?.fence).toBe(1)

    // Another tab claims and writes the lease — but this tab misses the storage event
    // entirely (never dispatched). Detection falls back to the renewal tick's re-claim.
    localStorage.setItem("loop-missed-event", JSON.stringify({ ownerId: "thief", fence: 2, expiresAt: Date.now() + 900 }))
    expect(ctxA?.signal.aborted).toBe(false)

    await world.advance(300) // the next tick's claim reports not-leader
    expect(ctxA?.signal.aborted).toBe(true)
    expect(order).toEqual(["aborted-then-lost"])
  })

  it("ctx.isStillLeader re-confirms under the lock and renews", async () => {
    world = createTabWorld()
    let ctxA: LeadershipContext | undefined
    createLeadershipLoop("loop-recheck", 900, (ctx) => {
      ctxA = ctx
    })
    await world.flush()

    await world.advance(600)
    await expect(ctxA?.isStillLeader()).resolves.toBe(true)
    // The re-check renewed: still leader past the original expiry.
    await world.advance(600)
    await expect(ctxA?.isStillLeader()).resolves.toBe(true)
  })
  it("validates ttlMs and renewIntervalMs at construction", () => {
    world = createTabWorld()
    const noop = () => {}
    // Misconfiguration fails fast at construction instead of electing no one silently.
    expect(() => createLeadershipLoop("loop-bad-ttl", 0, noop)).toThrow(RangeError)
    expect(() => createLeadershipLoop("loop-bad-renew-zero", 900, noop, { renewIntervalMs: 0 })).toThrow(RangeError)
    expect(() => createLeadershipLoop("loop-bad-renew-nan", 900, noop, { renewIntervalMs: NaN })).toThrow(RangeError)
    // renewIntervalMs >= ttlMs: the lease would lapse between renewals — leadership flaps.
    expect(() => createLeadershipLoop("loop-flap-eq", 900, noop, { renewIntervalMs: 900 })).toThrow(/flap/)
    expect(() => createLeadershipLoop("loop-flap-gt", 900, noop, { renewIntervalMs: 1_000 })).toThrow(RangeError)
    expect(() => createLeadershipLoop("loop-ok", 900, noop, { renewIntervalMs: 300 })).not.toThrow()
  })
})

describe("createLeadershipLoop with Web Locks available", () => {
  let world: TabWorld

  beforeEach(() => {
    // Same as above: the 900ms test TTL sits in the sub-second warn zone by design.
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    world.cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("self-heals when a tick's acquire times out waiting for the lock", async () => {
    world = createTabWorld()
    const locks = installFakeLocks()
    const warn = vi.fn()
    let releaseHolder!: () => void
    void locks.request("loop-heal", () => new Promise<void>((resolve) => (releaseHolder = resolve)))

    const onLeadership = vi.fn()
    createLeadershipLoop("loop-heal", 3_000, onLeadership, { waitTimeoutMs: 100, logger: { warn } })
    // The first tick (t=0) queues behind the stuck holder; at t=100 the wait times out, the
    // tick fails, gets logged — and the loop lives on instead of silently jamming `ticking`.
    await world.advance(150)
    expect(onLeadership).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("tick failed")

    releaseHolder()
    await world.advance(1_000) // the next tick (t=1000 = ttlMs/3) acquires the now-free lock
    expect(onLeadership).toHaveBeenCalledTimes(1)
  })

  it("elects exactly one leader among two loops contending for the same lock", async () => {
    world = createTabWorld()
    installFakeLocks()
    const onA = vi.fn()
    const onB = vi.fn()
    createLeadershipLoop("loop-locked", 900, onA)
    createLeadershipLoop("loop-locked", 900, onB)

    await world.advance(3_000)

    expect(onA.mock.calls.length + onB.mock.calls.length).toBe(1)
  })

  it("routes claims through options.lockName", async () => {
    world = createTabWorld()
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void locks.request("loop-custom-lock", () => new Promise<void>((resolve) => (releaseHolder = resolve)))
    expect(locks.isHeld("loop-custom-lock")).toBe(true)

    const onLeadership = vi.fn()
    createLeadershipLoop("loop-lockname", 900, onLeadership, { lockName: "loop-custom-lock" })
    await world.flush()
    // The claim is queued behind the holder — no leadership until the lock frees up.
    expect(onLeadership).not.toHaveBeenCalled()
    expect(locks.pendingCount("loop-custom-lock")).toBe(1)

    releaseHolder()
    await world.flush()
    expect(onLeadership).toHaveBeenCalledTimes(1)
  })

  it("renews on options.renewIntervalMs instead of ttlMs / 3", async () => {
    world = createTabWorld()
    installFakeLocks()
    createLeadershipLoop("loop-renewal-interval", 900, () => {}, { renewIntervalMs: 100 })
    await world.flush()
    const initial = (JSON.parse(localStorage.getItem("loop-renewal-interval")!) as { expiresAt: number }).expiresAt

    // ttlMs / 3 would not tick until 300ms; a renewal at 100ms proves the option took effect.
    await world.advance(100)
    const renewed = (JSON.parse(localStorage.getItem("loop-renewal-interval")!) as { expiresAt: number }).expiresAt
    expect(renewed).toBeGreaterThan(initial)
  })

  it("warns through options.logger when onLeadership throws, and the loop lives on", async () => {
    world = createTabWorld()
    installFakeLocks()
    const warn = vi.fn()
    let calls = 0
    createLeadershipLoop(
      "loop-throwing",
      3_000,
      () => {
        calls++
        throw new Error("boom")
      },
      { logger: { warn } },
    )
    await world.flush()
    await world.flush() // let the rejection reach the loop's catch
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("onLeadership")

    // The throw didn't kill the loop: renewals keep landing, same tenure, no repeat call.
    await world.advance(1_000)
    const stored = JSON.parse(localStorage.getItem("loop-throwing")!) as { expiresAt: number }
    expect(stored.expiresAt).toBeGreaterThan(Date.now())
    expect(calls).toBe(1)
  })
})
