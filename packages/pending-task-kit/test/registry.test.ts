import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPendingTaskRegistryBinding } from "../src/registry"
import { createPendingTaskStore } from "../src/store"

describe("createPendingTaskRegistryBinding", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("addTaskIfMissing skips re-adding a task another tab already persisted", () => {
    const store = createPendingTaskStore({ storageKey: "registry-exists-persisted" })
    const { addTaskIfMissing } = createPendingTaskRegistryBinding(store, {})

    // Simulate another tab's write landing in localStorage before this tab's `storage`
    // listener has re-synced the in-memory snapshot.
    localStorage.setItem(
      "registry-exists-persisted",
      JSON.stringify({ state: { tasks: [{ id: "a", type: "demo", taskId: 1, startedAt: Date.now() }] } }),
    )

    addTaskIfMissing({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    expect(store.getState().tasks).toHaveLength(0)
  })

  it("does not treat a stale persisted entry as still-tracked once this tab's own writes are failing", () => {
    const store = createPendingTaskStore({ storageKey: "registry-stale-after-failure" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const { addTaskIfMissing } = createPendingTaskRegistryBinding(store, {})

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })

    // Removed directly, but the write fails — memory drops "a", localStorage still has it.
    store.getState().removeTask("a")
    expect(store.getState().tasks).toHaveLength(0)
    expect(store.hasUnpersistedWrites).toBe(true)

    setItemSpy.mockRestore()

    // Re-registering "a" must not be blocked by the stale (not-actually-another-tab) persisted
    // entry left over from this tab's own failed write.
    addTaskIfMissing({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    expect(store.getState().tasks).toHaveLength(1)
  })
})
