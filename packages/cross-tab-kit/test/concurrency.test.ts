import { afterEach, describe, expect, it, vi } from "vitest"
import { tryWithTabLock, withTabLock } from "../src/locks/tab-lock"
import { createLeadershipGate } from "../src/patterns/leadership-gate"
import { createPollLeaseClaimer } from "../src/primitives/poll-lease"
import { installFakeLocks } from "./harness/fake-locks"
import { createSteppableStorage } from "./harness/steppable"
import { createTabWorld, type TabWorld } from "./harness/tabs"

/**
 * Race playbooks — each one reproduces a real failure mode by controlling the interleaving
 * of storage reads/writes (the only place single-realm jsdom differs from real tabs).
 */
describe("concurrency playbooks", () => {
  let world: TabWorld

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("two tabs claiming on the same tick both read the pre-claim state — the race the lock exists to prevent", () => {
    const steppable = createSteppableStorage()
    try {
      const claimerA = createPollLeaseClaimer("race-claim", 10_000)
      const claimerB = createPollLeaseClaimer("race-claim", 10_000)

      // Pause both tabs' reads at the empty state, then let each decide and write:
      // A reads (empty) → B reads (still empty) → A writes → B writes.
      steppable.freezeReads("race-claim")
      const a = claimerA.claim("owner-a")
      const b = claimerB.claim("owner-b")

      // Both won: without arbitration the check-then-claim race makes two leaders for a
      // tick. This is exactly why claim() must be composed with withTabLock (and why the
      // fail-open write path self-heals on the next claim instead of pretending it worked).
      expect(a).toEqual({ leader: true, fence: 1 })
      expect(b).toEqual({ leader: true, fence: 1 })

      steppable.unfreezeReads("race-claim")
      // The next unlocked claim reads the other tab's now-real lease and steps back.
      expect(claimerA.claim("owner-a")).toEqual({ leader: false })
    } finally {
      steppable.restore()
    }
  })

  it("try-lock colliding with a holder skips instead of queueing", async () => {
    const locks = installFakeLocks()
    let releaseHolder!: () => void
    void withTabLock("race-try", () => new Promise<void>((resolve) => (releaseHolder = resolve)))
    await vi.waitFor(() => expect(locks.isHeld("race-try")).toBe(true))

    await expect(tryWithTabLock("race-try", () => "should not run")).resolves.toEqual({ acquired: false })
    releaseHolder()
  })

  it("after a timeout releases the lock, a second tab gets in while the first operation is still hung", async () => {
    world = createTabWorld()
    try {
      const locks = installFakeLocks()
      let firstOpSettled = false
      const first = withTabLock(
        "race-timeout",
        () =>
          // The hung operation itself: it never settles, timeout or not.
          new Promise<string>(() => {}).then((value) => {
            firstOpSettled = true
            return value
          }),
        { timeoutMs: 100 },
      )
      const firstAssertion = expect(first).rejects.toMatchObject({ name: "TimeoutError" })
      await world.flush()
      expect(locks.isHeld("race-timeout")).toBe(true)

      await world.advance(100) // first times out, releasing the lock
      await firstAssertion

      // Mutual exclusion was briefly broken: the second tab runs while the first tab's
      // operation is still hung in the background — the residual risk timeoutMs trades for
      // liveness, which is why side effects inside must be idempotent.
      await expect(tryWithTabLock("race-timeout", () => "second ran")).resolves.toEqual({ acquired: true, value: "second ran" })
      expect(firstOpSettled).toBe(false)
    } finally {
      world.cleanup()
    }
  })

  it("a fence captured before the lease was taken and returned no longer proves leadership", async () => {
    world = createTabWorld()
    try {
      const gateA = createLeadershipGate("race-fence", 1_000)
      const gateB = createLeadershipGate("race-fence", 1_000)

      const tenure1 = await gateA.acquire()
      expect(tenure1?.fence).toBe(1)

      await world.advance(1_000) // A's lease lapses (A was busy/frozen)
      const tenureB = await gateB.acquire() // B takes it (fence 2), does its work
      expect(tenureB?.fence).toBe(2)
      gateB.release()

      // A comes back and re-acquires under the same owner id — a new fence, not a renewal.
      const tenure2 = await gateA.acquire()
      expect(tenure2?.fence).toBe(3)

      // The stale tenure's fence comparison catches the churn an owner-id check would miss.
      await expect(tenure1?.isStillValid()).resolves.toBe(false)
      await expect(tenure2?.isStillValid()).resolves.toBe(true)
    } finally {
      world.cleanup()
    }
  })
})
