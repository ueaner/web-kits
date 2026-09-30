import { act, cleanup, render } from "@testing-library/react"
import { StrictMode } from "react"
import { hydrateRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { usePendingTaskPoller, usePendingTasks } from "../src/react"
import { createPendingTaskStore, type PendingTaskStore } from "../src/store"
import type { PendingTaskRegistry } from "../src/types"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function TestComponent(props: {
  store: PendingTaskStore
  registry: PendingTaskRegistry
  onResult?: (detail: unknown) => void
  onTick?: (info: { durationMs: number; taskCount: number }) => void
}) {
  usePendingTaskPoller({
    store: props.store,
    registry: props.registry,
    onResult: props.onResult,
    onTick: props.onTick,
  })
  return null
}

describe("usePendingTaskPoller", () => {
  it("keeps polling correctly after React StrictMode's mount→unmount→remount dance", async () => {
    // StrictMode deliberately mounts every effect twice in development (mount, cleanup,
    // mount again) to surface missing cleanup. The discarded first instance's own cleanup
    // (stop(), which releases *its own* lease under *its own* ownerId — see
    // PollLeaseClaimer.release) must not interfere with the surviving second instance.
    const store = createPendingTaskStore({ storageKey: "react-strictmode" })
    // Already overdue at mount, so the very first (non-forced) tick finds it due immediately —
    // see engine.ts's `due` check, which otherwise wouldn't fire within this test's short wait.
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() - 100_000 })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    // A short pollIntervalMs so the task looks due again well within this test's wait below —
    // the default (10s) would make a passing assertion indistinguishable from a genuinely
    // stopped poller within any reasonable test timeout.
    const registry: PendingTaskRegistry = { demo: { check, pollIntervalMs: 300 } }

    render(
      <StrictMode>
        <TestComponent store={store} registry={registry} />
      </StrictMode>,
    )

    await flush()
    const callsAfterMount = check.mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)

    // The surviving instance's own setInterval must still be alive and ticking on its own —
    // proves the discarded first mount's cleanup didn't somehow also stop the second,
    // surviving instance (they have separate ownerIds and separate intervalIds).
    await new Promise((resolve) => setTimeout(resolve, 2_500)) // past pollTickMs + pollIntervalMs
    expect(check.mock.calls.length).toBeGreaterThan(callsAfterMount)
  })

  it("forces an immediate re-check when the document becomes visible again", async () => {
    const store = createPendingTaskStore({ storageKey: "react-visibility" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    // A long pollIntervalMs so natural ticking wouldn't fire it within this test's short
    // window — only the visibilitychange-triggered forceCheckAll should.
    const registry: PendingTaskRegistry = { demo: { check, pollIntervalMs: 60_000 } }

    render(<TestComponent store={store} registry={registry} />)
    await flush()
    expect(check).not.toHaveBeenCalled()

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await flush()

    expect(check).toHaveBeenCalledTimes(1)
  })

  it("keeps callback options fresh across re-renders, without tearing down the poller", async () => {
    const store = createPendingTaskStore({ storageKey: "react-fresh-callbacks" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() - 100_000 })

    const check = vi.fn().mockResolvedValue({ status: "success", data: {} })
    const registry: PendingTaskRegistry = { demo: { check } }

    const onResultA = vi.fn()
    const onResultB = vi.fn()

    const { rerender } = render(<TestComponent store={store} registry={registry} onResult={onResultA} />)

    // Re-render with a *different* onResult closure, same store/registry identity (so the
    // effect's own dependency array doesn't retrigger and tear down/rebuild the poller) —
    // if the hook only captured the initial onResultA closure at mount instead of always
    // reading through optionsRef at call time, onResultA (not onResultB) would fire below.
    rerender(<TestComponent store={store} registry={registry} onResult={onResultB} />)

    await flush()

    expect(onResultA).not.toHaveBeenCalled()
    expect(onResultB).toHaveBeenCalledTimes(1)
  })

  it("forwards onTick (and every other callback option) through to the poller, kept fresh across re-renders", async () => {
    // Regression test: the hook explicitly re-wraps each callback option so it always reads
    // through optionsRef at call time (see the comment on that list in react.ts) — but
    // onLeaderChange/onTick were added to PendingTaskPollerOptions without being added to
    // that list, so they'd silently pin to whatever closure was captured at mount instead.
    const store = createPendingTaskStore({ storageKey: "react-on-tick-forwarding" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: Date.now() - 100_000 })

    const check = vi.fn().mockResolvedValue({ status: "pending" })
    const registry: PendingTaskRegistry = { demo: { check } }

    const onTickA = vi.fn()
    const onTickB = vi.fn()

    const { rerender } = render(<TestComponent store={store} registry={registry} onTick={onTickA} />)
    rerender(<TestComponent store={store} registry={registry} onTick={onTickB} />)

    await flush()

    expect(onTickA).not.toHaveBeenCalled()
    expect(onTickB).toHaveBeenCalled()
  })
})

describe("usePendingTasks", () => {
  it("renders the store's tasks and re-renders when the store is written", () => {
    const store = createPendingTaskStore({ storageKey: "react-use-tasks" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })

    function TaskIds() {
      const tasks = usePendingTasks(store)
      return <span data-testid="ids">{tasks.map((t) => t.id).join(",")}</span>
    }
    const { getByTestId } = render(<TaskIds />)
    expect(getByTestId("ids").textContent).toBe("a")

    act(() => store.getState().addTask({ id: "b", type: "demo", taskId: 2, startedAt: 2 }))
    expect(getByTestId("ids").textContent).toBe("a,b")

    act(() => store.getState().removeTask("a"))
    expect(getByTestId("ids").textContent).toBe("b")
  })

  it("keeps a derived selection referentially stable across re-renders that don't touch the store", () => {
    const store = createPendingTaskStore({ storageKey: "react-use-tasks-select" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
    store.getState().addTask({ id: "b", type: "other", taskId: 2, startedAt: 2 })

    // Returns a fresh array on every call — without the hook's memoization this would loop
    // forever under useSyncExternalStore, and hand back a new identity on every re-render.
    const select = (tasks: { type: string }[]) => tasks.filter((t) => t.type === "demo")
    const stable: unknown[] = []
    function StableDemoTasks(_props: { tick: number }) {
      stable.push(usePendingTasks(store, select))
      return null
    }
    const { rerender } = render(<StableDemoTasks tick={0} />)
    rerender(<StableDemoTasks tick={1} />)
    expect(stable.length).toBeGreaterThanOrEqual(2)
    expect(stable[0]).toEqual([expect.objectContaining({ id: "a" })])
    expect(stable.at(-1)).toBe(stable[0])

    act(() => store.getState().addTask({ id: "c", type: "demo", taskId: 3, startedAt: 3 }))
    expect(stable.at(-1)).not.toBe(stable[0])
    expect(stable.at(-1)).toEqual([expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "c" })])
  })

  it("keeps an inline filter selector's result referentially stable across unrelated re-renders", () => {
    const store = createPendingTaskStore({ storageKey: "react-use-tasks-inline" })
    store.getState().addTask({ id: "a", type: "demo", taskId: 1, startedAt: 1 })
    store.getState().addTask({ id: "b", type: "other", taskId: 2, startedAt: 2 })

    const seen: unknown[] = []
    function InlineDemoTasks(_props: { tick: number }) {
      // A new selector function *and* a new filtered array on every render.
      seen.push(usePendingTasks(store, (tasks) => tasks.filter((t) => t.type === "demo")))
      return null
    }
    const { rerender } = render(<InlineDemoTasks tick={0} />)
    rerender(<InlineDemoTasks tick={1} />)
    rerender(<InlineDemoTasks tick={2} />)

    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen.every((value) => value === seen[0])).toBe(true)
  })

  it("hydrates server markup (rendered without localStorage) without a mismatch, then shows the persisted tasks", async () => {
    const storageKey = "react-use-tasks-hydrate"
    localStorage.setItem(storageKey, JSON.stringify({ state: { tasks: [{ id: "a", type: "demo", taskId: 1, startedAt: 1 }] }, version: 1 }))
    const store = createPendingTaskStore({ storageKey })

    function TaskCount() {
      return <span>{usePendingTasks(store).length}</span>
    }
    const container = document.createElement("div")
    container.innerHTML = "<span>0</span>" // what the server rendered: no localStorage there
    document.body.appendChild(container)

    const recoverableErrors: unknown[] = []
    let root: ReturnType<typeof hydrateRoot> | undefined
    await act(async () => {
      root = hydrateRoot(container, <TaskCount />, { onRecoverableError: (error) => recoverableErrors.push(error) })
    })

    expect(recoverableErrors).toEqual([])
    expect(container.textContent).toBe("1")
    act(() => root?.unmount())
    container.remove()
  })
})
