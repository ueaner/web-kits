import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPendingTaskStore, readPersistedTasks } from "../src/store"

describe("createPendingTaskStore", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("adds, updates, and removes tasks, replacing by id", () => {
    const store = createPendingTaskStore({ storageKey: "test-tasks" })

    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: Date.now(),
    })
    expect(store.getState().tasks).toHaveLength(1)

    store.getState().addTask({
      id: "a",
      type: "demo",
      taskId: 1,
      startedAt: 123,
    })
    expect(store.getState().tasks).toHaveLength(1)
    expect(store.getState().tasks[0]?.startedAt).toBe(123)

    store.getState().updateTask("a", { lastCheckedAt: 999 })
    expect(store.getState().tasks[0]?.lastCheckedAt).toBe(999)

    store.getState().removeTask("a")
    expect(store.getState().tasks).toHaveLength(0)
  })

  it("prunes tasks for which the predicate returns false", () => {
    const store = createPendingTaskStore({ storageKey: "test-tasks-prune" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

    store.getState().pruneTasksBy((task) => task.taskId === 1)

    expect(store.getState().tasks).toEqual([
      expect.objectContaining({ id: "a", taskId: 1 }),
    ])
  })

  it("persists to the given localStorage key", () => {
    const store = createPendingTaskStore({ storageKey: "test-tasks-persist" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const raw = localStorage.getItem("test-tasks-persist")
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).state.tasks).toHaveLength(1)
  })

  it("readPersistedTasks degrades to an empty list, rather than throwing, when localStorage access itself throws", () => {
    // Regression test: readPersistedTasks used to read `localStorage` directly, unguarded — a
    // browser with site data/storage fully disabled can make even accessing `localStorage`
    // throw a SecurityError, which would otherwise propagate straight out of every store
    // mutator, `addTaskIfMissing`, and the poller's `flushBatch`.
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })

    expect(() => readPersistedTasks("test-tasks-storage-disabled")).not.toThrow()
    expect(readPersistedTasks("test-tasks-storage-disabled")).toEqual([])

    getItemSpy.mockRestore()
  })

  it("clearAllTasks empties the store", () => {
    const store = createPendingTaskStore({ storageKey: "test-tasks-clear" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().clearAllTasks()
    expect(store.getState().tasks).toHaveLength(0)
  })

  describe("taskListWarnThreshold", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    })

    afterEach(() => {
      // In an `afterEach`, not at the end of each test body, so a failed assertion mid-test
      // can't leak the mock into later tests.
      warnSpy.mockRestore()
    })

    it("warns exactly once when the task count crosses the threshold", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-warn", taskListWarnThreshold: 2 })

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
      expect(warnSpy).not.toHaveBeenCalled()

      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })
      store.getState().addTask({ id: "c", type: "demo", taskId: 3, startedAt: Date.now() })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain("test-tasks-warn")

      // Stays past the threshold — must not warn again for this store's lifetime.
      store.getState().addTask({ id: "d", type: "demo", taskId: 4, startedAt: Date.now() })
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it("does not warn at exactly the threshold, only once it's exceeded", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-warn-boundary", taskListWarnThreshold: 2 })

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })
      expect(warnSpy).not.toHaveBeenCalled() // exactly at the threshold — not past it yet

      store.getState().addTask({ id: "c", type: "demo", taskId: 3, startedAt: Date.now() })
      expect(warnSpy).toHaveBeenCalledTimes(1) // now past it
    })

    it("never warns when taskListWarnThreshold is Infinity", () => {
      const store = createPendingTaskStore({
        storageKey: "test-tasks-warn-disabled",
        taskListWarnThreshold: Infinity,
      })

      for (let i = 0; i < 5; i++) {
        store.getState().addTask({ id: `t${i}`, type: "demo", taskId: i, startedAt: Date.now() })
      }
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("falls back to the default threshold when given NaN, instead of comparing against it directly", () => {
      const store = createPendingTaskStore({
        storageKey: "test-tasks-warn-nan",
        taskListWarnThreshold: Number.NaN,
      })

      for (let i = 0; i < 5; i++) {
        store.getState().addTask({ id: `t${i}`, type: "demo", taskId: i, startedAt: Date.now() })
      }
      // 5 tasks doesn't cross the real default threshold (200). Without the NaN guard, `length
      // <= NaN` is always false regardless of `length` — so it would instead warn immediately,
      // spuriously, even at 0 tasks (any comparison against NaN is false, in both directions).
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("warns on the initial rehydrate from an already-oversized persisted list, not just on the next mutation", () => {
      const storageKey = "test-tasks-warn-rehydrate"
      // Seed localStorage directly, as if a previous session (or another tab) had already
      // grown the list past the threshold, bypassing this store's own writeTasks entirely.
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: {
            tasks: Array.from({ length: 3 }, (_, i) => ({
              id: `t${i}`,
              type: "demo",
              taskId: i,
              startedAt: Date.now(),
            })),
          },
          version: 0,
        }),
      )

      createPendingTaskStore({ storageKey, taskListWarnThreshold: 2 })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain(storageKey)
    })
  })
})
