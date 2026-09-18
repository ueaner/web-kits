import { cleanup, render } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { usePendingTaskPoller } from "../src/react"
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
