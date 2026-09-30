// The React component under test in react-binding.spec.ts, shared by both sides of the SSR
// test: the spec server-renders it in Node (via `react-dom/server`, where there's no
// `localStorage`), and react-fixture.ts renders/hydrates it in a real browser. Written with
// `createElement` rather than JSX so the same file runs unchanged in both places — Node has no
// JSX transform, and the Vite dev server serving the fixture isn't configured with one either.
// Imports the built `dist/` output, same as fixture.ts.
import { createElement as h } from "react"
import type { PendingTaskRegistry, PendingTaskResultEventDetail, PendingTaskStore } from "../dist/index.js"
import { usePendingTaskPoller, usePendingTasks } from "../dist/react.js"

export interface TaskListAppProps {
  store: PendingTaskStore
  /** Mounts `usePendingTaskPoller` too when set (effects only — renders nothing on the server). */
  poller?: {
    registry: PendingTaskRegistry
    pollTickMs: number
    defaultPollIntervalMs: number
    onResult: (detail: PendingTaskResultEventDetail) => void
  }
}

function PollerDriver(props: { store: PendingTaskStore; poller: NonNullable<TaskListAppProps["poller"]> }) {
  usePendingTaskPoller({ store: props.store, ...props.poller })
  return null
}

export function TaskListApp(props: TaskListAppProps) {
  const tasks = usePendingTasks(props.store)
  // An inline selector building a fresh array on every call — exercised in a real renderer too.
  const demoTasks = usePendingTasks(props.store, (all) => all.filter((task) => task.type === "demo"))
  return h(
    "div",
    null,
    props.poller ? h(PollerDriver, { store: props.store, poller: props.poller }) : null,
    h("p", { "data-testid": "count" }, String(tasks.length)),
    h("p", { "data-testid": "demo-count" }, String(demoTasks.length)),
    h(
      "ul",
      { "data-testid": "list" },
      tasks.map((task) => h("li", { key: task.id }, task.id)),
    ),
  )
}
