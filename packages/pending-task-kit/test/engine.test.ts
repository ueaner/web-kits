import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingTaskPoller } from "../src/engine"
import { createPendingTaskStore } from "../src/store"
import type { PendingTaskHandler, PendingTaskRegistry } from "../src/types"

describe("PendingTaskPoller", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })

  it("keeps a pending task and merges progress into metadata", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-pending" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending", progress: { percent: 42, stage: "uploading" } })
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry })
    poller.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(1)
    expect(store.getState().tasks).toHaveLength(1)
    expect(store.getState().tasks[0]?.metadata?.percent).toBe(42)
    expect(store.getState().tasks[0]?.metadata?.stage).toBe("uploading")
    poller.stop()
  })

  it("removes a success task and calls onResult", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-done" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "success", data: { href: "/x" } })
    const onResult = vi.fn()
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry, onResult })
    poller.forceCheckAll()
    await flush()

    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", data: { href: "/x" } }),
    )
    poller.stop()
  })

  it("suppresses onResult when the handler sets silentOnSuccess", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-silent" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "success" })
    const onResult = vi.fn()
    const handler: PendingTaskHandler = { check, silentOnSuccess: true }
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: handler },
      onResult,
    })
    poller.forceCheckAll()
    await flush()

    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).not.toHaveBeenCalled()
    poller.stop()
  })

  it("silently drops an expired task without a final check", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-expired" })
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    const check = vi.fn()
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check } },
      onResult,
    })
    poller.forceCheckAll()
    await flush()

    expect(check).not.toHaveBeenCalled()
    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).not.toHaveBeenCalled()
    poller.stop()
  })

  it("gives the handler one final check at expiry when finalCheckOnExpiry is set", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-final-check" })
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    const check = vi.fn().mockResolvedValue({ status: "success" })
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check, finalCheckOnExpiry: true } },
      onResult,
    })
    poller.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }))
    poller.stop()
  })

  it("gives up after maxFailureCount consecutive check errors", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-failures" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockRejectedValue(new Error("boom"))
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check } },
      onResult,
      maxFailureCount: 2,
    })

    poller.forceCheckAll()
    await flush()
    expect(store.getState().tasks).toHaveLength(1)
    expect(onResult).not.toHaveBeenCalled()

    poller.forceCheckAll()
    await flush()
    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }))
    poller.stop()
  })

  it("does not let claimResultOnce rejecting during a maxFailureCount finalize crash the tick", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-failure-claim-rejects" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockRejectedValue(new Error("boom"))
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check } },
      onResult,
      maxFailureCount: 1,
      claimResultOnce: () => Promise.reject(new Error("claim failed")),
    })

    poller.forceCheckAll()
    await flush()

    // finalize() had already recorded the removal before claimResultOnce rejected, so the task
    // is still gone and the tick doesn't blow up — it just skips the (failed) notification.
    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).not.toHaveBeenCalled()
    poller.stop()
  })

  it("stops the tick without counting a failure when onCheckError returns true", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-check-error-pause" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockRejectedValue(new Error("SESSION_ENDED"))
    const onCheckError = vi.fn((error: unknown) => error instanceof Error && error.message === "SESSION_ENDED")
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check } },
      onCheckError,
    })
    poller.forceCheckAll()
    await flush()

    expect(onCheckError).toHaveBeenCalledTimes(1)
    // Task is left as-is (not counted as a normal failure) since the caller decided to pause.
    expect(store.getState().tasks).toHaveLength(1)
    poller.stop()
  })

  it("gates the final dispatch through claimResultOnce", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-claim" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "success" })
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check } },
      onResult,
      claimResultOnce: () => false,
    })
    poller.forceCheckAll()
    await flush()

    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).not.toHaveBeenCalled()
    poller.stop()
  })

  it("expires (not errors) a finalCheckOnExpiry task whose one last check fails, without retrying it", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-final-check-failure" })
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    const check = vi.fn().mockRejectedValue(new Error("boom"))
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check, finalCheckOnExpiry: true } },
      onResult,
    })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).not.toHaveBeenCalled()

    // A second forced tick must not re-run the already-consumed final check.
    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it("removes an expired task that has no registered handler instead of leaving it forever", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-ghost-task" })
    store.getState().addTask({
      id: "a",
      type: "removedType",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    const poller = new PendingTaskPoller({ store, registry: {} })
    poller.forceCheckAll()
    await flush()

    expect(store.getState().tasks).toHaveLength(0)
    poller.stop()
  })

  it("resyncs to an empty task list when another tab calls localStorage.clear()", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-storage-clear" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const poller = new PendingTaskPoller({ store, registry: {} })
    poller.start()
    expect(store.getState().tasks).toHaveLength(1)

    window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }))

    expect(store.getState().tasks).toHaveLength(0)
    poller.stop()
  })

  it("keeps finalCheckOnExpiry's one-last-look allowance when onCheckError intercepts the attempt", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-final-check-intercepted" })
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    let shouldIntercept = true
    const check = vi.fn().mockImplementation(() =>
      shouldIntercept ? Promise.reject(new Error("SESSION_ENDED")) : Promise.resolve({ status: "success" }),
    )
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check, finalCheckOnExpiry: true } },
      onResult,
      onCheckError: (error) => error instanceof Error && error.message === "SESSION_ENDED",
    })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    // Left as-is by the interception, not force-expired.
    expect(store.getState().tasks).toHaveLength(1)

    // The condition that caused onCheckError to intercept clears (e.g. the session is restored).
    shouldIntercept = false
    poller.forceCheckAll()
    await flush()

    // It must still get its genuine final check rather than being force-expired without one.
    expect(check).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }))
    poller.stop()
  })

  it("surfaces (does not swallow) an onCheckError that itself throws, instead of leaving the task stuck", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-check-error-throws" })
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    const check = vi.fn().mockRejectedValue(new Error("boom"))
    const onCheckError = vi.fn(() => {
      throw new Error("bug in onCheckError")
    })
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check, finalCheckOnExpiry: true } },
      onResult,
      onCheckError,
    })

    // onCheckError is documented to return a boolean, not throw. A throw here must not leave
    // the task (and its finalCheckAttempted entry) stuck forever in the store — it falls
    // through to the same "expired" handling as if onCheckError had returned false — and the
    // bug itself must surface rather than vanish, so a one-shot listener asserts on it instead
    // of letting it otherwise escape the test process uncaught.
    const surfaced = new Promise<unknown>((resolve) => {
      onUncaughtException(resolve)
    })
    poller.forceCheckAll()
    await flush()

    await expect(surfaced).resolves.toMatchObject({ message: "bug in onCheckError" })
    expect(check).toHaveBeenCalledTimes(1)
    expect(store.getState().tasks).toHaveLength(0)
    expect(onResult).not.toHaveBeenCalled()
    poller.stop()
  })

  it("does not let a stale finalCheckAttempted flag leak onto a task id reused after a direct removal", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-stale-flag-reuse" })
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    const check = vi.fn().mockRejectedValue(new Error("SESSION_ENDED"))
    const poller = new PendingTaskPoller({
      store,
      registry: { demo: { check, finalCheckOnExpiry: true } },
      onCheckError: () => true,
    })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    expect(store.getState().tasks).toHaveLength(1)

    // The app removes the task directly (bypassing the poller's own finalize) and later reuses
    // the same id for a brand-new, unrelated task.
    store.getState().removeTask("a")
    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 2,
      startedAt: Date.now() - 1_000,
      ttlMs: 500,
    })

    poller.forceCheckAll()
    await flush()

    // The new task under the same id gets its own genuine final check, not a force-expiry
    // driven by a flag left over from the unrelated old task.
    expect(check).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it("keeps processing remaining tasks in a tick even when the persisted write fails", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-storage-write-failure" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry })

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    poller.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(2)
    // In-memory state stays intact despite the persisted write failing.
    expect(store.getState().tasks).toHaveLength(2)

    setItemSpy.mockRestore()
    poller.stop()
  })

  it("does not resurrect a task removed by a direct mutator whose write failed, on the poller's next flush", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-shared-write-flag" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry })

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    // A direct mutator call (bypassing the poller entirely) fails to persist — localStorage
    // still holds "a", but memory and `hasUnpersistedWrites` both reflect the failure.
    store.getState().removeTask("a")
    expect(store.getState().tasks.map((t) => t.id)).toEqual(["b"])
    expect(store.hasUnpersistedWrites).toBe(true)

    setItemSpy.mockRestore()

    // The poller's own flushBatch must see the same shared flag and build on memory instead of
    // the stale persisted snapshot, or it would silently resurrect "a".
    poller.forceCheckAll()
    await flush()

    expect(store.getState().tasks.map((t) => t.id)).toEqual(["b"])
    expect(store.hasUnpersistedWrites).toBe(false)
    poller.stop()
  })

  it("flushes a whole tick's task updates in a single persisted write", async () => {
    const storageKey = "engine-batched-writes"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })
    store.getState().addTask({ id: "c", type: "demo", taskId: 3, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry })

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem")
    setItemSpy.mockClear() // drop the 3 setup-time writes from the addTask calls above

    poller.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(3)
    // One batched write for the whole tick's task list, not one per task — filtered to this
    // store's own key, since crossTabPollLeaderElection now also writes (a different key) to
    // claim/renew the poll-leader lease; that's an intentional, separate localStorage entry,
    // not something this assertion is about.
    const taskStoreWrites = setItemSpy.mock.calls.filter(([key]) => key === storageKey)
    expect(taskStoreWrites).toHaveLength(1)

    // The poll-leader lease is claimed once up front and then renewed once per processed task
    // (to survive a slow handler.check()), not twice per task — total writes for the tick stay
    // a bounded, known number rather than growing unnoticed.
    const leaseWrites = setItemSpy.mock.calls.filter(([key]) => key !== storageKey)
    expect(leaseWrites).toHaveLength(check.mock.calls.length + 1)
    expect(setItemSpy.mock.calls).toHaveLength(taskStoreWrites.length + leaseWrites.length)

    setItemSpy.mockRestore()
    poller.stop()
  })

  // jsdom has no `navigator.locks`, so every leader-election test in this file exercises
  // `withTabLock`'s unlocked fallback path (see `src/tab-lock.ts`), not real Web Locks
  // arbitration — the read-then-write in `PollLeaseClaimer.claim` runs without genuine
  // cross-tab mutual exclusion here. That's fine for these tests (jsdom is single-threaded, so
  // there's no actual interleaving to race), but it means a real browser's Web Locks queuing
  // behavior specifically is never exercised by this suite.

  it("only lets one of two pollers sharing a store actually call check() (cross-tab leader election)", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-leader-election" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    // Two instances sharing one store/storageKey stand in for two browser tabs — they read
    // and write the same (real, synchronous) localStorage, exactly like two real tabs would.
    const pollerA = new PendingTaskPoller({ store, registry })
    const pollerB = new PendingTaskPoller({ store, registry })

    pollerA.forceCheckAll()
    pollerB.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(1)

    pollerA.stop()
    pollerB.stop()
  })

  it("lets a second poller naturally take over once the first tab's lease expires, without an explicit stop()", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-natural-expiry" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    // pollerA is never stop()ped — standing in for a crashed or frozen tab whose lease is left
    // to expire on its own TTL rather than being released, unlike the "release on stop()" test.
    const pollerA = new PendingTaskPoller({ store, registry, pollLeaseTtlMs: 20 })
    pollerA.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)

    // Generous margin over the 20ms TTL (real timers, not mocked) so this can't flake under
    // CI load — waiting longer only makes the lease more expired, never less, so there's no
    // corresponding downside to widening this.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const pollerB = new PendingTaskPoller({ store, registry, pollLeaseTtlMs: 20 })
    pollerB.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(2)

    pollerB.stop()
  })

  it("lets every poller independently call check() when crossTabPollLeaderElection is off", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-no-leader-election" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollerA = new PendingTaskPoller({ store, registry, crossTabPollLeaderElection: false })
    const pollerB = new PendingTaskPoller({ store, registry, crossTabPollLeaderElection: false })

    pollerA.forceCheckAll()
    pollerB.forceCheckAll()
    await flush()

    expect(check).toHaveBeenCalledTimes(2)

    pollerA.stop()
    pollerB.stop()
  })

  it("discards a stale response if leadership moved to another tab while a check() call was in flight", async () => {
    const storageKey = "engine-stale-response"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    let resolveCheck!: (value: { status: "pending"; progress: { percent: number } }) => void
    const check = vi.fn(
      () =>
        new Promise<{ status: "pending"; progress: { percent: number } }>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollLeaseKey = `${storageKey}-poll-leader`
    const poller = new PendingTaskPoller({ store, registry, pollLeaseKey })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)

    // Simulate another tab's poller claiming the lease while this request is in flight —
    // written directly (bypassing this poller's own claim()) so the test doesn't depend on
    // real elapsed time or pollLeaseTtlMs actually expiring. `fence: 2` mirrors what a genuine
    // rival claim would compute (this poller's own in-flight claim above was fence 1; a real
    // rival reading this now-expired-looking lease would bump it from there).
    localStorage.setItem(
      pollLeaseKey,
      JSON.stringify({ ownerId: "other-tab", fence: 2, expiresAt: Date.now() + 10_000 }),
    )

    resolveCheck({ status: "pending", progress: { percent: 42 } })
    await flush()

    // The stale response must never have been applied — metadata was never touched.
    expect(store.getState().tasks[0]?.metadata).toBeUndefined()

    poller.stop()
  })

  it("discards a stale response even after leadership churned through another tab and back to this one", async () => {
    // Regression test for a gap a plain "is a different owner currently holding it" check can't
    // see: this tab's lease expires mid-check(), another tab claims it and fully finishes with
    // it (releasing it again), and by the time this tab's stale response comes back, the lease
    // is unheld again — so this tab's own stable owner id can legitimately reclaim it. Only
    // comparing the lease's fence (not just current ownership) catches that leadership genuinely
    // changed hands in between.
    const storageKey = "engine-stale-response-after-churn"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    let resolveCheck!: (value: { status: "pending"; progress: { percent: number } }) => void
    const check = vi.fn(
      () =>
        new Promise<{ status: "pending"; progress: { percent: number } }>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollLeaseKey = `${storageKey}-poll-leader`
    const poller = new PendingTaskPoller({ store, registry, pollLeaseKey })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    // This poller's own in-flight claim above was fence 1.

    // Simulate another tab claiming the lease (fence 2) while this request is in flight, fully
    // processing it, and then releasing it — leaving the lease unheld again but with the fence
    // already moved on, exactly like `PollLeaseClaimer.release` writes it.
    localStorage.setItem(
      pollLeaseKey,
      JSON.stringify({ ownerId: "other-tab", fence: 2, expiresAt: 0 }),
    )

    resolveCheck({ status: "pending", progress: { percent: 42 } })
    await flush()

    // Even though this tab can legitimately reclaim the now-unheld lease under its own owner id,
    // the fence mismatch (1 captured vs. 3 on reclaim) must still discard the stale response.
    expect(store.getState().tasks[0]?.metadata).toBeUndefined()

    poller.stop()
  })

  it("skips handler.check() entirely for later due tasks in the same tick once leadership is lost mid-tick", async () => {
    // Regression test for a bug where losing leadership partway through a tick (via a
    // post-check reconfirm failure) left `fence` at its old, stale value instead of resetting
    // it to `undefined` — bypassing the pre-check block's `leadershipLost` short-circuit for
    // every later task, so they went ahead and called handler.check() anyway. Their stale
    // responses were still correctly discarded, but the redundant network call
    // `crossTabPollLeaderElection` exists to prevent still happened.
    const storageKey = "engine-leadership-lost-midtick"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    let resolveCheckA!: (value: { status: "pending" }) => void
    const check = vi.fn(
      () =>
        new Promise<{ status: "pending" }>((resolve) => {
          resolveCheckA = resolve
        }),
    )
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollLeaseKey = `${storageKey}-poll-leader`
    const poller = new PendingTaskPoller({ store, registry, pollLeaseKey })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1) // only task "a" so far — its check() is in flight

    // Simulate another tab taking over the lease while task "a"'s check() is still in flight.
    localStorage.setItem(
      pollLeaseKey,
      JSON.stringify({ ownerId: "other-tab", fence: 2, expiresAt: Date.now() + 10_000 }),
    )

    resolveCheckA({ status: "pending" })
    await flush()

    // Task "a"'s stale response must be discarded, and — the point of this test — task "b"
    // must never have called handler.check() at all once leadership was lost.
    expect(check).toHaveBeenCalledTimes(1)

    poller.stop()
  })

  it("skips handler.check() for a later due task in the same tick once a consumer callback calls stop() mid-tick", async () => {
    // Regression test for a gap in the previous fix: the `this.stopped` short-circuit lived
    // only inside the `fence === undefined` branch, so once an earlier task's own reconfirm
    // had already set a valid `fence` for this tick, a stop() call from consumer code (e.g.
    // onResult itself calling poller.stop(), or a React component unmounting) between two
    // tasks would never be noticed for any task after it — `fence !== undefined` would skip
    // the whole block, including the stopped check nested inside it.
    const storageKey = "engine-stop-between-tasks"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "success", data: {} })
    const registry: PendingTaskRegistry = { demo: { check } }
    let poller!: PendingTaskPoller
    const onResult = vi.fn(() => {
      poller.stop()
    })
    poller = new PendingTaskPoller({ store, registry, onResult })

    poller.forceCheckAll()
    await flush()

    // onResult stops the poller right after task "a" finishes — task "b" must never have
    // called handler.check() at all.
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("skips handler.check() for later due tasks when a mid-tick leadership loss is discovered on the error path", async () => {
    // Symmetric to "skips handler.check() entirely for later due tasks..." above, but for the
    // catch branch's own reconfirm-and-reset-fence logic — a separate code path from the
    // success branch's, so it needs its own coverage rather than relying on the success-path
    // test to also exercise it.
    const storageKey = "engine-leadership-lost-midtick-error"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    let rejectCheckA!: (error: Error) => void
    const check = vi.fn(
      () =>
        new Promise<{ status: "pending" }>((_resolve, reject) => {
          rejectCheckA = reject
        }),
    )
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollLeaseKey = `${storageKey}-poll-leader`
    const poller = new PendingTaskPoller({ store, registry, pollLeaseKey })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1) // only task "a" so far — its check() is in flight

    // Simulate another tab taking over the lease while task "a"'s check() is still in flight.
    localStorage.setItem(
      pollLeaseKey,
      JSON.stringify({ ownerId: "other-tab", fence: 2, expiresAt: Date.now() + 10_000 }),
    )

    rejectCheckA(new Error("boom"))
    await flush()

    // Task "b" must never have called handler.check() at all once leadership was lost, even
    // though the loss was discovered via the error path this time.
    expect(check).toHaveBeenCalledTimes(1)

    poller.stop()
  })

  it("releases the poll-leader lease on stop() so another poller can take over immediately", async () => {
    const store = createPendingTaskStore({ storageKey: "engine-release-on-stop" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollerA = new PendingTaskPoller({ store, registry, pollLeaseTtlMs: 10_000 })

    pollerA.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)

    pollerA.stop()
    await flush() // let the fire-and-forget release land

    const pollerB = new PendingTaskPoller({ store, registry, pollLeaseTtlMs: 10_000 })
    pollerB.forceCheckAll()
    await flush()

    // If the lease weren't released on stop(), pollerB would have to wait out the full 10s TTL.
    expect(check).toHaveBeenCalledTimes(2)

    pollerB.stop()
  })

  it("re-dispatches a relayed result from another tab's leader on this tab's own window", async () => {
    const storageKey = "engine-relay-receive"
    const store = createPendingTaskStore({ storageKey })
    const poller = new PendingTaskPoller({ store, registry: {} })
    poller.start()

    const events: unknown[] = []
    const listener = (event: Event) => events.push((event as CustomEvent).detail)
    window.addEventListener("pending-task-result", listener)

    const relayedTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }
    const relayedDetail = { task: relayedTask, status: "success" }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `${storageKey}-result-relay`,
        newValue: JSON.stringify(relayedDetail),
      }),
    )

    expect(events).toEqual([relayedDetail])

    window.removeEventListener("pending-task-result", listener)
    poller.stop()
  })

  it("lets acceptRelayedResult veto a relayed result on the receiving side", async () => {
    const storageKey = "engine-relay-veto"
    const store = createPendingTaskStore({ storageKey })
    const acceptRelayedResult = vi.fn().mockReturnValue(false)
    const poller = new PendingTaskPoller({ store, registry: {}, acceptRelayedResult })
    poller.start()

    const events: unknown[] = []
    const listener = (event: Event) => events.push((event as CustomEvent).detail)
    window.addEventListener("pending-task-result", listener)

    const relayedTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }
    const relayedDetail = { task: relayedTask, status: "success" }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `${storageKey}-result-relay`,
        newValue: JSON.stringify(relayedDetail),
      }),
    )

    expect(acceptRelayedResult).toHaveBeenCalledWith(relayedDetail)
    expect(events).toHaveLength(0)

    window.removeEventListener("pending-task-result", listener)
    poller.stop()
  })

  it("writes the result relay entry even when dispatchDomEvent is off, so other tabs still learn the result", async () => {
    const storageKey = "engine-relay-send-no-dom"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "success", data: { href: "/x" } })
    const registry: PendingTaskRegistry = { demo: { check } }
    // The primary documented integration path: only onResult wired up, no DOM event dispatch.
    const poller = new PendingTaskPoller({ store, registry, dispatchDomEvent: false })

    poller.forceCheckAll()
    await flush()

    const raw = localStorage.getItem(`${storageKey}-result-relay`)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toMatchObject({ status: "success" })

    poller.stop()
  })

  it("still writes the result relay even when the leader's own onResult throws", async () => {
    const storageKey = "engine-relay-onresult-throws"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "success", data: { ok: true } })
    const onResult = vi.fn(() => {
      throw new Error("bug in onResult")
    })
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry, onResult })

    // A bug in this tab's own onResult is still surfaced (not swallowed) — see the similar
    // onCheckError test above — but must not be able to prevent every other tab from learning
    // the result via the relay, which is written before onResult runs precisely so a throw here
    // can't take it down too.
    const surfaced = new Promise<unknown>((resolve) => {
      onUncaughtException(resolve)
    })
    poller.forceCheckAll()
    await flush()

    await expect(surfaced).resolves.toMatchObject({ message: "bug in onResult" })
    const raw = localStorage.getItem(`${storageKey}-result-relay`)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toMatchObject({ status: "success" })

    poller.stop()
  })

  it("fires onResult (not just the DOM event) when receiving a relayed result", async () => {
    const storageKey = "engine-relay-onresult"
    const store = createPendingTaskStore({ storageKey })
    const onResult = vi.fn()
    const poller = new PendingTaskPoller({ store, registry: {}, onResult })
    poller.start()

    const relayedTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }
    const relayedDetail = { task: relayedTask, status: "success" }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `${storageKey}-result-relay`,
        newValue: JSON.stringify(relayedDetail),
      }),
    )
    await flush()

    expect(onResult).toHaveBeenCalledWith(relayedDetail)

    poller.stop()
  })

  it("gates a relayed result through claimResultOnce, the same as the leader's own local dispatch", async () => {
    const storageKey = "engine-relay-dedupe"
    const store = createPendingTaskStore({ storageKey })
    const onResult = vi.fn()
    const claimResultOnce = vi.fn().mockReturnValue(false)
    const poller = new PendingTaskPoller({ store, registry: {}, onResult, claimResultOnce })
    poller.start()

    const relayedTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }
    const relayedDetail = { task: relayedTask, status: "success" }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `${storageKey}-result-relay`,
        newValue: JSON.stringify(relayedDetail),
      }),
    )
    await flush()

    expect(claimResultOnce).toHaveBeenCalledWith(relayedTask)
    // Composing claimResultOnce with a shared cross-tab dedupe cache should be able to suppress
    // a relayed notification exactly like it suppresses the leader's own, not just the latter.
    expect(onResult).not.toHaveBeenCalled()

    poller.stop()
  })

  it("does not abort the rest of a tick's tasks when a result's data can't be JSON-serialized for the relay", async () => {
    const storageKey = "engine-relay-nonserializable"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const check = vi
      .fn()
      .mockResolvedValueOnce({ status: "success", data: circular })
      .mockResolvedValueOnce({ status: "success", data: { ok: true } })
    const onResult = vi.fn()
    const registry: PendingTaskRegistry = { demo: { check } }
    const poller = new PendingTaskPoller({ store, registry, onResult })

    poller.forceCheckAll()
    await flush()

    // Both tasks still get their local onResult — only the first task's relay write (whose data
    // can't be serialized) is silently skipped, not the rest of the tick's processing.
    expect(onResult).toHaveBeenCalledTimes(2)
    expect(store.getState().tasks).toHaveLength(0)

    poller.stop()
  })

  it("does not re-claim a fresh full-TTL lease when stop() is called while a check() is still in flight", async () => {
    const storageKey = "engine-stop-inflight-lease"
    const store = createPendingTaskStore({ storageKey })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    let resolveCheck!: (value: { status: "pending" }) => void
    const check = vi.fn(
      () =>
        new Promise<{ status: "pending" }>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const registry: PendingTaskRegistry = { demo: { check } }
    const pollLeaseKey = `${storageKey}-poll-leader`
    const poller = new PendingTaskPoller({ store, registry, pollLeaseKey, pollLeaseTtlMs: 10_000 })

    poller.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)

    poller.stop()
    await flush() // let the fire-and-forget release land

    const releasedRaw = localStorage.getItem(pollLeaseKey)
    expect(JSON.parse(releasedRaw as string).expiresAt).toBeLessThanOrEqual(Date.now())

    resolveCheck({ status: "pending" })
    await flush()

    // The stopped poller's in-flight reconfirm must not have written a fresh, full-TTL lease —
    // otherwise another tab would have to wait out the full 10s TTL despite stop() having
    // already released it.
    const stillReleasedRaw = localStorage.getItem(pollLeaseKey)
    expect(JSON.parse(stillReleasedRaw as string).expiresAt).toBeLessThanOrEqual(Date.now())

    const pollerB = new PendingTaskPoller({ store, registry, pollLeaseKey, pollLeaseTtlMs: 10_000 })
    pollerB.forceCheckAll()
    await flush()
    expect(check).toHaveBeenCalledTimes(2)

    pollerB.stop()
  })
})

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Vitest runs under Node, but this project has no `@types/node` (it never touches Node APIs
 *  outside this one test) — declared narrowly here rather than pulling in the whole package. */
declare const process: { once: (event: "uncaughtException", listener: (error: unknown) => void) => void }

function onUncaughtException(listener: (error: unknown) => void): void {
  process.once("uncaughtException", listener)
}
