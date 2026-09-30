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
    it("hydrates a pre-versioning persisted entry (version 0) as-is", () => {
      // The shape 0.2.0 and earlier actually wrote (zustand's persist serialized a default
      // `version: 0` alongside the state). Any version must hydrate — discarding a mismatched
      // one would silently wipe every pre-upgrade user's tasks.
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

    it("hydrates a version-less entry as-is", () => {
      // Not a shape any released version wrote — pinned for robustness, so a future migration
      // step doesn't accidentally start discarding these.
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

    it("writes the same { state: { tasks }, version: 1 } shape 0.6.0 and earlier (zustand persist) wrote", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-persist-shape" })
      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 123 })

      expect(JSON.parse(localStorage.getItem("test-tasks-persist-shape") as string)).toEqual({
        state: { tasks: [{ id: "a", type: "demo", taskId: 1, startedAt: 123 }] },
        version: 1,
      })
    })
  })

  describe("subscribe", () => {
    it("notifies listeners with the new and previous snapshot on every write, until unsubscribed", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-subscribe" })
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)
      const before = store.getState()

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      expect(listener).toHaveBeenCalledTimes(1)
      const [next, previous] = listener.mock.calls[0] as [ReturnType<typeof store.getState>, ReturnType<typeof store.getState>]
      expect(previous).toBe(before)
      expect(next).toBe(store.getState())
      expect(next).not.toBe(before)
      expect(next.tasks).toHaveLength(1)
      // Mutators stay the same functions across snapshots.
      expect(next.addTask).toBe(before.addTask)

      store.writeTasks([])
      expect(listener).toHaveBeenCalledTimes(2)

      unsubscribe()
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2 })
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it("surfaces a throwing listener without aborting the write or starving the listeners after it", async () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-subscribe-throwing" })
      const second = vi.fn()
      store.subscribe(() => {
        throw new Error("bug in listener")
      })
      store.subscribe(second)

      const surfaced = new Promise<unknown>((resolve) => {
        process.once("uncaughtException", resolve)
      })
      expect(() => store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })).not.toThrow()

      expect(store.getState().tasks).toHaveLength(1)
      expect(readPersistedTasks("test-tasks-subscribe-throwing")).toHaveLength(1)
      expect(second).toHaveBeenCalledTimes(1)
      await expect(surfaced).resolves.toMatchObject({ message: "bug in listener" })
    })

    it("lets a re-entrant write win, so no listener ends on a stale snapshot", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-subscribe-reentrant" })
      const pairs: [number, number][] = []
      store.subscribe((state) => {
        if (state.tasks.length === 1) store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2 })
      })
      store.subscribe((state, previous) => pairs.push([previous.tasks.length, state.tasks.length]))

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })

      // Only the nested, newer write reaches it — the outer delivery stops once it's stale,
      // instead of arriving afterwards and leaving this listener on the old state — and its
      // `previousState` is the last snapshot *it* saw (0 tasks), so a diff still shows both
      // additions rather than silently skipping the outer write's "a".
      expect(pairs).toEqual([[0, 2]])
      expect(store.getState().tasks).toHaveLength(2)
    })

    it("doesn't call a listener that another listener unsubscribed earlier in the same notification", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-subscribe-unsub-other" })
      const second = vi.fn()
      store.subscribe(() => unsubscribeSecond())
      const unsubscribeSecond = store.subscribe(second)

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      expect(second).not.toHaveBeenCalled()
    })

    it("treats each subscribe call as its own subscription, even for the same function", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-subscribe-duplicate" })
      const listener = vi.fn()
      const unsubscribeFirst = store.subscribe(listener)
      store.subscribe(listener)

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      expect(listener).toHaveBeenCalledTimes(2)

      unsubscribeFirst()
      unsubscribeFirst() // idempotent — must not remove the other subscription
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2 })
      expect(listener).toHaveBeenCalledTimes(3)
    })

    it("still notifies a listener's peers when that listener unsubscribes itself mid-notification", () => {
      const store = createPendingTaskStore({ storageKey: "test-tasks-subscribe-self-remove" })
      const second = vi.fn()
      const unsubscribeFirst = store.subscribe(() => unsubscribeFirst())
      store.subscribe(second)

      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      expect(second).toHaveBeenCalledTimes(1)
    })
  })

  describe("cross-tab sync", () => {
    /** Simulates another tab writing `tasks`: the shared storage changes, then this tab gets a
     *  `storage` event (which never fires in the tab that made the write). */
    function writeFromOtherTab(storageKey: string, tasks: unknown[]): void {
      const newValue = JSON.stringify({ state: { tasks }, version: 1 })
      localStorage.setItem(storageKey, newValue)
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue, storageArea: localStorage }))
    }

    it("adopts another tab's write while subscribed, in memory only — never writing it back", () => {
      const storageKey = "test-tasks-sync"
      const store = createPendingTaskStore({ storageKey })
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)

      const setItemSpy = vi.spyOn(Storage.prototype, "setItem")
      const raw = JSON.stringify({ state: { tasks: [{ id: "x", type: "demo", taskId: 1, startedAt: 1 }] }, version: 1 })
      try {
        localStorage.setItem(storageKey, raw)
        setItemSpy.mockClear()
        window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: raw, storageArea: localStorage }))
        expect(setItemSpy).not.toHaveBeenCalled()
      } finally {
        setItemSpy.mockRestore()
      }
      expect(store.getState().tasks.map((t) => t.id)).toEqual(["x"])
      expect(listener).toHaveBeenCalledTimes(1)
      unsubscribe()
    })

    it("adopts what storage holds now, not a stale event's newValue", () => {
      const storageKey = "test-tasks-sync-stale-event"
      const store = createPendingTaskStore({ storageKey })
      store.subscribe(() => {})

      const older = JSON.stringify({ state: { tasks: [{ id: "v1", type: "demo", taskId: 1, startedAt: 1 }] }, version: 1 })
      // Storage already moved on to a newer value by the time the older event is handled.
      localStorage.setItem(
        storageKey,
        JSON.stringify({ state: { tasks: [{ id: "v2", type: "demo", taskId: 2, startedAt: 2 }] }, version: 1 }),
      )
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: older, storageArea: localStorage }))

      expect(store.getState().tasks.map((t) => t.id)).toEqual(["v2"])
      expect(readPersistedTasks(storageKey).map((t) => t.id)).toEqual(["v2"])
    })

    it("doesn't notify for a storage event that leaves the persisted value unchanged", () => {
      const storageKey = "test-tasks-sync-unchanged"
      const store = createPendingTaskStore({ storageKey })
      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      const listener = vi.fn()
      store.subscribe(listener)
      const before = store.getState()

      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, storageArea: localStorage }))

      expect(listener).not.toHaveBeenCalled()
      expect(store.getState()).toBe(before)
    })

    it("ignores other keys and sessionStorage events", () => {
      const storageKey = "test-tasks-sync-ignore"
      const store = createPendingTaskStore({ storageKey })
      const listener = vi.fn()
      store.subscribe(listener)
      localStorage.setItem(
        storageKey,
        JSON.stringify({ state: { tasks: [{ id: "x", type: "demo", taskId: 1, startedAt: 1 }] }, version: 1 }),
      )

      window.dispatchEvent(new StorageEvent("storage", { key: "some-other-key", storageArea: localStorage }))
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, storageArea: sessionStorage }))

      expect(listener).not.toHaveBeenCalled()
      expect(store.getState().tasks).toHaveLength(0)
    })

    it("stops listening once the last subscriber leaves, and re-syncs when a new one arrives", () => {
      const storageKey = "test-tasks-sync-lifecycle"
      const store = createPendingTaskStore({ storageKey })
      const unsubscribe = store.subscribe(() => {})
      unsubscribe()

      writeFromOtherTab(storageKey, [{ id: "x", type: "demo", taskId: 1, startedAt: 1 }])
      // Nobody subscribed — not kept current.
      expect(store.getState().tasks).toHaveLength(0)

      store.subscribe(() => {})
      // The first new subscriber catches it up with what it missed.
      expect(store.getState().tasks.map((t) => t.id)).toEqual(["x"])
    })

    it("doesn't re-sync over in-memory-only tasks when a subscriber arrives with storage unavailable", () => {
      const storageKey = "test-tasks-sync-unpersisted"
      const store = createPendingTaskStore({ storageKey })
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })
      try {
        store.getState().addTask({ id: "memory-only", type: "demo", taskId: 1, startedAt: 1 })
        expect(store.hasUnpersistedWrites).toBe(true)
        store.subscribe(() => {})
        expect(store.getState().tasks.map((t) => t.id)).toEqual(["memory-only"])
      } finally {
        setItemSpy.mockRestore()
      }
    })

    it("still adopts an unchanged persisted value while this tab has unpersisted writes", () => {
      const storageKey = "test-tasks-sync-unchanged-unpersisted"
      const store = createPendingTaskStore({ storageKey })
      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      store.subscribe(() => {})
      const persistedBefore = localStorage.getItem(storageKey) as string

      // Unserializable — this write stays in memory only.
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2, metadata: { size: BigInt(1) } })
      expect(store.hasUnpersistedWrites).toBe(true)

      // Another tab writes, then restores the exact previous value — both before this tab gets
      // to handle either event, so both handlers read the restored (unchanged) value.
      const intermediate = JSON.stringify({
        state: {
          tasks: [
            { id: "a", type: "demo", taskId: 1, startedAt: 1 },
            { id: "c", type: "demo", taskId: 3, startedAt: 3 },
          ],
        },
        version: 1,
      })
      localStorage.setItem(storageKey, intermediate)
      localStorage.setItem(storageKey, persistedBefore)
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: intermediate, storageArea: localStorage }))
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: persistedBefore, storageArea: localStorage }))

      // Memory mirrors storage again, and the flag says so truthfully.
      expect(store.hasUnpersistedWrites).toBe(false)
      expect(store.getState().tasks.map((t) => t.id)).toEqual(["a"])
      expect(readPersistedTasks(storageKey).map((t) => t.id)).toEqual(["a"])
    })

    it("adopts an unchanged persisted value on its very first event while this tab has unpersisted writes", () => {
      const storageKey = "test-tasks-sync-first-event-unpersisted"
      const store = createPendingTaskStore({ storageKey })
      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      store.subscribe(() => {})
      store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2, metadata: { size: BigInt(1) } })

      window.dispatchEvent(new StorageEvent("storage", { key: storageKey, storageArea: localStorage }))

      expect(store.hasUnpersistedWrites).toBe(false)
      expect(store.getState().tasks.map((t) => t.id)).toEqual(["a"])
    })

    it("empties when another tab clears localStorage", () => {
      const storageKey = "test-tasks-sync-clear"
      const store = createPendingTaskStore({ storageKey })
      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
      store.subscribe(() => {})

      localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }))

      expect(store.getState().tasks).toHaveLength(0)
    })
  })

  describe("write failures", () => {
    it("treats an unserializable task list (e.g. a BigInt in metadata) as a failed write, not a crash", () => {
      const storageKey = "test-tasks-unserializable"
      const store = createPendingTaskStore({ storageKey })
      store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })

      expect(() =>
        store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2, metadata: { size: BigInt(1) } }),
      ).not.toThrow()
      expect(store.hasUnpersistedWrites).toBe(true)
      expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "b"])
      // The last good persisted snapshot is left intact rather than overwritten with garbage.
      expect(readPersistedTasks(storageKey).map((t) => t.id)).toEqual(["a"])

      store.getState().removeTask("b")
      expect(store.hasUnpersistedWrites).toBe(false)
      expect(readPersistedTasks(storageKey).map((t) => t.id)).toEqual(["a"])
    })

    it("keeps every task in memory when localStorage writes fail, instead of rebuilding from the stale persisted list", () => {
      const storageKey = "test-tasks-write-failure"
      const store = createPendingTaskStore({ storageKey })
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })
      try {
        store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
        expect(store.hasUnpersistedWrites).toBe(true)
        // Built on the in-memory list, not the (empty) persisted one — "a" must survive.
        store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2 })
        expect(store.getState().tasks.map((t) => t.id)).toEqual(["a", "b"])
      } finally {
        setItemSpy.mockRestore()
      }

      // The next successful write clears the flag and persists the full list.
      store.getState().addTask({ id: "c", type: "demo", taskId: 3, startedAt: 3 })
      expect(store.hasUnpersistedWrites).toBe(false)
      expect(readPersistedTasks(storageKey).map((t) => t.id)).toEqual(["a", "b", "c"])
    })
  })
})

/** `process` from Node's own globals (vitest runs under Node; jsdom doesn't remove it), used
 *  to observe an error this package deliberately rethrows on a fresh microtask — declared
 *  narrowly here rather than pulling in all of `@types/node`, same as `engine.test.ts`. */
declare const process: { once: (event: "uncaughtException", listener: (error: unknown) => void) => void }
