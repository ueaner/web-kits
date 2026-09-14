import { beforeEach, describe, expect, it } from "vitest"
import { createPendingTaskStore } from "../src/store"

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

  it("clearAllTasks empties the store", () => {
    const store = createPendingTaskStore({ storageKey: "test-tasks-clear" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })
    store.getState().clearAllTasks()
    expect(store.getState().tasks).toHaveLength(0)
  })
})
