// Real-browser verification of the React binding (`usePendingTasks`, `usePendingTaskPoller`)
// against the built `dist/` — see react-fixture.ts. Each test uses its own storageKey so tests
// never read each other's tasks, even though they share one localStorage origin.
import { expect, test, type Page } from "@playwright/test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { createPendingTaskStore } from "../dist/index.js"
import type { PendingTask } from "../dist/index.js"
import { TaskListApp } from "./task-list-app"

type MountOptions = Parameters<Window["mountApp"]>[0]

function task(id: string, overrides: Partial<PendingTask> = {}): PendingTask {
  return { id, type: "demo", taskId: id, startedAt: Date.now(), ...overrides }
}

/** Collects console errors and uncaught page errors — a React warning (hydration mismatch,
 *  "getSnapshot should be cached", an update loop) is logged via console.error. */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(String(error)))
  return errors
}

async function mount(page: Page, opts: MountOptions): Promise<void> {
  await page.goto("/test-e2e/react-fixture.html")
  await page.evaluate((o) => window.mountApp(o), opts)
}

function renderedIds(page: Page): Promise<string[]> {
  return page.getByTestId("list").locator("li").allTextContents()
}

test("renders persisted tasks on load and re-renders on every local write", async ({ page }) => {
  const errors = collectErrors(page)
  await mount(page, { storageKey: "e2e-react-local", seed: [task("a"), task("b", { type: "other" })] })

  await expect.poll(() => renderedIds(page)).toEqual(["a", "b"])
  await expect(page.getByTestId("demo-count")).toHaveText("1")

  await page.evaluate(() => window.taskStore.getState().addTask({ id: "c", type: "demo", taskId: "c", startedAt: Date.now() }))
  await expect.poll(() => renderedIds(page)).toEqual(["a", "b", "c"])
  await expect(page.getByTestId("demo-count")).toHaveText("2")

  await page.evaluate(() => window.taskStore.getState().removeTask("a"))
  await expect.poll(() => renderedIds(page)).toEqual(["b", "c"])

  await page.evaluate(() => window.taskStore.getState().clearAllTasks())
  await expect(page.getByTestId("count")).toHaveText("0")
  expect(errors).toEqual([])
})

test("a write in one real tab re-renders the task list in another, with no poller mounted", async ({ browser }) => {
  const context = await browser.newContext()
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  const errorsA = collectErrors(pageA)
  const errorsB = collectErrors(pageB)

  // No poller in either tab: subscribing via usePendingTasks is what keeps the store syncing
  // with other tabs.
  const opts: MountOptions = { storageKey: "e2e-react-cross-tab" }
  await mount(pageA, opts)
  await mount(pageB, opts)

  await pageA.evaluate(() => window.taskStore.getState().addTask({ id: "x", type: "demo", taskId: "x", startedAt: Date.now() }))
  await expect.poll(() => renderedIds(pageB)).toEqual(["x"])

  await pageB.evaluate(() => window.taskStore.getState().addTask({ id: "y", type: "demo", taskId: "y", startedAt: Date.now() }))
  await expect.poll(() => renderedIds(pageA)).toEqual(["x", "y"])

  await pageA.evaluate(() => window.taskStore.getState().removeTask("x"))
  await expect.poll(() => renderedIds(pageB)).toEqual(["y"])

  expect([...errorsA, ...errorsB]).toEqual([])
  await context.close()
})

test("the poller resolves a task end to end: it leaves the rendered list and reaches onResult", async ({ page }) => {
  const errors = collectErrors(page)
  await mount(page, {
    storageKey: "e2e-react-success",
    seed: [task("done", { startedAt: Date.now() - 1_000 })],
    poll: { result: "success", defaultPollIntervalMs: 10 },
  })

  await expect.poll(() => renderedIds(page)).toEqual([])
  const results = await page.evaluate(() => window.results.map((r) => ({ id: r.task.id, status: r.status, silent: r.silent })))
  expect(results).toEqual([{ id: "done", status: "success", silent: false }])
  expect(errors).toEqual([])
})

test("an expired task leaves the rendered list and reaches onResult as a silent 'expired'", async ({ page }) => {
  const errors = collectErrors(page)
  await mount(page, {
    storageKey: "e2e-react-expired",
    seed: [task("stale", { startedAt: Date.now() - 10_000, ttlMs: 1_000 })],
    poll: { result: "pending" },
  })

  await expect.poll(() => renderedIds(page)).toEqual([])
  const results = await page.evaluate(() => window.results.map((r) => ({ id: r.task.id, status: r.status, silent: r.silent })))
  expect(results).toEqual([{ id: "stale", status: "expired", silent: true }])
  expect(errors).toEqual([])
})

test("hydrates markup server-rendered in Node (no localStorage) without a mismatch, then shows persisted tasks", async ({ page }) => {
  // Genuine server render: this runs in the Playwright runner's Node process, where
  // `localStorage` doesn't exist — the store starts empty and `usePendingTasks` takes its
  // server-snapshot path, exactly as under a real SSR framework.
  const ssrHtml = renderToString(createElement(TaskListApp, { store: createPendingTaskStore({ storageKey: "e2e-react-ssr" }) }))
  expect(ssrHtml).toContain('data-testid="count">0<')

  const errors = collectErrors(page)
  // The browser, unlike the server, has a persisted task — the classic hydration-mismatch setup.
  await mount(page, { storageKey: "e2e-react-ssr", seed: [task("persisted")], ssrHtml })

  await expect.poll(() => renderedIds(page)).toEqual(["persisted"])
  await expect(page.getByTestId("count")).toHaveText("1")
  // A mismatch is reported through onRecoverableError (and logged) around the hydration
  // commit; give it a moment to surface before asserting there was none.
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => window.recoverableErrors)).toEqual([])
  expect(errors).toEqual([])
})
