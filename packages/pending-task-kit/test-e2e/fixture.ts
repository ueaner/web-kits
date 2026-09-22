// Minimal page used only by the Playwright suite (see leader-election.spec.ts) to exercise
// cross-tab poll-leader election and the result relay in a *real* browser — the one thing the
// jsdom-based vitest suite structurally can't do (no `navigator.locks`, no genuine `storage`
// events between separate tabs). Imports the built `dist/index.js` deliberately, not `src/`, so
// this also doubles as a build-output smoke test.
import { createPendingTaskStore, PendingTaskPoller } from "../dist/index.js"
import type { PendingTaskRegistry } from "../dist/index.js"

interface StartPollerOptions {
  storageKey: string
  pollLeaseKey: string
  pollLeaseTtlMs?: number
  pollTickMs?: number
  result?: "pending" | "success"
}

declare global {
  interface Window {
    checkCalls: number
    lastResult: unknown
    startPoller: (opts: StartPollerOptions) => void
  }
}

window.checkCalls = 0
window.lastResult = null

window.startPoller = (opts) => {
  const store = createPendingTaskStore({ storageKey: opts.storageKey })
  store.getState().addTask({ id: "task-a", type: "demo", taskId: 1, startedAt: Date.now() })

  const registry: PendingTaskRegistry = {
    demo: {
      check: async () => {
        window.checkCalls++
        return opts.result === "success" ? { status: "success", data: { ok: true } } : { status: "pending" }
      },
    },
  }

  new PendingTaskPoller({
    store,
    registry,
    pollLeaseKey: opts.pollLeaseKey,
    pollLeaseTtlMs: opts.pollLeaseTtlMs,
    pollTickMs: opts.pollTickMs,
    // start()'s own first tick isn't forced, so a task added moments ago (lastCheckedAt is
    // effectively "now") wouldn't be due yet under the default 10s interval — this fixture
    // wants ticks to actually happen quickly, not to exercise defaultPollIntervalMs itself.
    defaultPollIntervalMs: 10,
    onResult: (detail) => {
      window.lastResult = detail
    },
  }).start()
}
