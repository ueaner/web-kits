// Page used by react-binding.spec.ts to exercise `pending-task-kit/react` (`usePendingTasks`,
// `usePendingTaskPoller`) in a real browser with the real React DOM renderer — including
// genuine cross-tab `storage` events and hydrating markup server-rendered in Node, neither of
// which the jsdom vitest suite can do faithfully. Imports the built `dist/`, like fixture.ts.
import { createElement } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { createPendingTaskStore } from "../dist/index.js"
import type { PendingTask, PendingTaskResultEventDetail, PendingTaskStore } from "../dist/index.js"
import { TaskListApp, type TaskListAppProps } from "./task-list-app"

interface MountOptions {
  storageKey: string
  /** Written to localStorage in the persisted shape before the store is created — as if left
   *  there by an earlier session. */
  seed?: PendingTask[]
  /** Mounts the poller too; every `check()` resolves to this status. */
  poll?: { result: "pending" | "success"; pollTickMs?: number; defaultPollIntervalMs?: number }
  /** Server-rendered markup to hydrate instead of rendering from scratch. */
  ssrHtml?: string
}

declare global {
  interface Window {
    mountApp: (opts: MountOptions) => void
    taskStore: PendingTaskStore
    results: PendingTaskResultEventDetail[]
    recoverableErrors: string[]
  }
}

window.results = []
window.recoverableErrors = []

window.mountApp = (opts) => {
  if (opts.seed) {
    localStorage.setItem(opts.storageKey, JSON.stringify({ state: { tasks: opts.seed }, version: 1 }))
  }
  const store = createPendingTaskStore({ storageKey: opts.storageKey })
  window.taskStore = store

  const props: TaskListAppProps = { store }
  if (opts.poll) {
    const result = opts.poll.result
    props.poller = {
      registry: {
        demo: { check: async () => (result === "success" ? { status: "success" } : { status: "pending" }) },
      },
      pollTickMs: opts.poll.pollTickMs ?? 50,
      defaultPollIntervalMs: opts.poll.defaultPollIntervalMs ?? 60_000,
      onResult: (detail) => {
        window.results.push(detail)
      },
    }
  }

  const container = document.getElementById("root")!
  const element = createElement(TaskListApp, props)
  if (opts.ssrHtml === undefined) {
    createRoot(container).render(element)
    return
  }
  container.innerHTML = opts.ssrHtml
  hydrateRoot(container, element, {
    onRecoverableError: (error) => {
      window.recoverableErrors.push(String(error))
    },
  })
}
