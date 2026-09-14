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
    const store = createPendingTaskStore({ storageKey: "engine-batched-writes" })
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
    // One batched write for the whole tick, not one per task.
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    setItemSpy.mockRestore()
    poller.stop()
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
