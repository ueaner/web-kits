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

    expect(store.getState().tasks).toEqual([expect.objectContaining({ id: "a", taskId: 1 })])
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

    it("routes the warning through a custom logger instead of console", () => {
      const warn = vi.fn()
      const store = createPendingTaskStore({
        storageKey: "test-tasks-warn-logger",
        taskListWarnThreshold: 2,
        logger: { warn },
      })

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })
      store.getState().addTask({ id: "c", type: "demo", taskId: 3, startedAt: Date.now() })

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain("test-tasks-warn-logger")
      // The default console channel (already mocked by this describe's beforeEach) stays silent.
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it("a throwing logger doesn't take down the write that triggered the warning", () => {
      const store = createPendingTaskStore({
        storageKey: "test-tasks-warn-throwing",
        taskListWarnThreshold: 1,
        logger: {
          warn: () => {
            throw new Error("telemetry is down")
          },
        },
      })

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
      // Crosses the threshold on this write; the logger throws, the write must still land.
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: Date.now() })

      expect(store.getState().tasks).toHaveLength(2)
    })
  })

  describe("persist versioning", () => {
    it("hydrates a pre-versioning persisted entry (version 0) via the pass-through migrate", () => {
      // The shape 0.2.0 and earlier actually wrote: zustand's persist serializes the default
      // `version: 0` alongside the state on every write, so real legacy entries carry a numeric
      // version that mismatches the current `version: 1`. That mismatch is what routes the
      // entry through `migrate` — without the pass-through, zustand would discard it entirely,
      // silently wiping every pre-upgrade user's tasks.
      const storageKey = "test-tasks-migrate-legacy"
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: { tasks: [{ id: "a", type: "demo", taskId: 1, startedAt: 123 }] },
          version: 0,
        }),
      )

      const store = createPendingTaskStore({ storageKey })

      expect(store.getState().tasks).toEqual([expect.objectContaining({ id: "a", type: "demo", taskId: 1, startedAt: 123 })])
    })

    it("hydrates a version-less entry as-is (robustness — zustand skips migrate when the field is absent)", () => {
      // Not a shape any released version wrote; zustand only calls `migrate` when the stored
      // version is a *number* that mismatches, so a missing version bypasses it entirely and
      // hydrates directly. Pinned so a future "route everything through migrate" refactor
      // doesn't accidentally start discarding these.
      const storageKey = "test-tasks-migrate-no-version"
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: { tasks: [{ id: "b", type: "demo", taskId: 2, startedAt: 456 }] },
        }),
      )

      const store = createPendingTaskStore({ storageKey })

      expect(store.getState().tasks).toEqual([expect.objectContaining({ id: "b", type: "demo", taskId: 2, startedAt: 456 })])
    })

    it("hydrates a current-version entry normally", () => {
      const storageKey = "test-tasks-migrate-current"
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: { tasks: [{ id: "a", type: "demo", taskId: 1, startedAt: 123 }] },
          version: 1,
        }),
      )

      const store = createPendingTaskStore({ storageKey })

      expect(store.getState().tasks).toHaveLength(1)
    })
  })
})
