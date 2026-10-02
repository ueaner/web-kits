// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { Component, StrictMode, Suspense, startTransition, useLayoutEffect, useState, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { DatabaseProvider, useDbClient, useDbQuery } from "../src/react/index"
import { createDbClient } from "../src/core/index"
import { createMemoryAdapter } from "../src/adapters/memory"
import { DbTabLockError } from "../src/core/errors"
import type { DbClient } from "../src/core/types"

// React 需要知道这是测试环境，act() 才会生效
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const MIGRATIONS = [{ version: 1, statements: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);"] }]

async function createClient(): Promise<DbClient> {
  return createDbClient({ name: "test", adapter: createMemoryAdapter(), migrations: MIGRATIONS })
}

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: undefined as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  render() {
    if (this.state.error !== undefined) {
      const error = this.state.error
      return <p>{`error: ${error instanceof DbTabLockError ? "tab-lock" : error instanceof Error ? error.message : String(error)}`}</p>
    }
    return this.props.children
  }
}

/**
 * 记下 fallback 真正显示（提交到页面）过几次：刷新期间不应该再出现。用 layout effect 计数，
 * 只算提交了的；React 在 transition 里可能会先渲染一下 fallback 再丢掉，那不算显示
 */
function createFallback() {
  const shown = { count: 0 }
  function Fallback() {
    useLayoutEffect(() => {
      shown.count++
    })
    return <p>loading</p>
  }
  return { shown, Fallback }
}

function Shell({ client, children, fallback = <p>loading</p> }: { client: Promise<DbClient>; children: ReactNode; fallback?: ReactNode }) {
  return (
    <Boundary>
      <DatabaseProvider client={client}>
        <Suspense fallback={fallback}>{children}</Suspense>
      </DatabaseProvider>
    </Boundary>
  )
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)))

/**
 * React 19 下测 Suspense 要用 await act(async …) 包住 render：同步的 act 里挂起以后，
 * promise 结束时的重试不会被执行
 */
async function mount(ui: ReactNode) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(ui)
  })
  return result
}

/** 让测试控制查询什么时候结束 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// 测试之间不共用 client，缓存挂在 client 上，所以互不影响
describe("useDbClient", () => {
  it("suspends until the client resolves, then renders", async () => {
    const client = await createClient()
    const { promise, resolve } = deferred<DbClient>()
    function Storage() {
      return <p>{`persistent: ${useDbClient().storage.persistent}`}</p>
    }
    await mount(
      <Shell client={promise}>
        <Storage />
      </Shell>,
    )
    expect(screen.getByText("loading")).toBeTruthy()
    await act(async () => resolve(client))
    expect(screen.getByText("persistent: false")).toBeTruthy()
  })

  it("throws the initialization error to the nearest error boundary, DbTabLockError included", async () => {
    function Probe() {
      useDbClient()
      return null
    }
    const failed = Promise.reject(new DbTabLockError())
    failed.catch(() => {})
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await mount(
      <Shell client={failed}>
        <Probe />
      </Shell>,
    )
    await flush()
    expect(screen.getByText("error: tab-lock")).toBeTruthy()
    spy.mockRestore()
  })

  it("throws when used outside a DatabaseProvider", () => {
    function Bare() {
      useDbClient()
      return null
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Bare />)).toThrow(/within a DatabaseProvider/)
    spy.mockRestore()
  })
})

function NoteCount() {
  const rows = useDbQuery(["count"], (db) => db.select<{ n: number }>("SELECT COUNT(*) AS n FROM notes;"))
  return <p>{`notes: ${rows[0]?.n}`}</p>
}

describe("useDbQuery", () => {
  it("suspends on the first read, then shows the data", async () => {
    const client = await createClient()
    const gate = deferred<string>()
    function Gated() {
      return <p>{`value: ${useDbQuery(["gated"], () => gate.promise)}`}</p>
    }
    await mount(
      <Shell client={Promise.resolve(client)}>
        <Gated />
      </Shell>,
    )
    expect(screen.getByText("loading")).toBeTruthy()
    await act(async () => gate.resolve("ready"))
    expect(screen.getByText("value: ready")).toBeTruthy()
  })

  it("re-queries after a write and keeps the old data on screen meanwhile", async () => {
    const client = await createClient()
    const { shown, Fallback } = createFallback()
    await mount(
      <Shell client={Promise.resolve(client)} fallback={<Fallback />}>
        <NoteCount />
      </Shell>,
    )
    await flush()
    expect(screen.getByText("notes: 0")).toBeTruthy()
    const before = shown.count

    await act(async () => {
      await client.execute("INSERT INTO notes (body) VALUES ('a');")
    })
    await flush()
    expect(screen.getByText("notes: 1")).toBeTruthy()
    expect(shown.count).toBe(before)
  })

  it("shows only the last result when writes come back to back and an earlier query is slower", async () => {
    const client = await createClient()
    const results: ReturnType<typeof deferred<string>>[] = []
    function Latest() {
      // 每次写入后的查询由测试决定什么时候结束
      const value = useDbQuery(["latest"], () => {
        const d = deferred<string>()
        results.push(d)
        return d.promise
      })
      return <p>{`value: ${value}`}</p>
    }
    await mount(
      <Shell client={Promise.resolve(client)}>
        <Latest />
      </Shell>,
    )
    await act(async () => results[0]!.resolve("initial"))
    await flush()
    expect(screen.getByText("value: initial")).toBeTruthy()

    await act(async () => {
      await client.execute("INSERT INTO notes (body) VALUES ('a');")
    })
    await flush()
    await act(async () => {
      await client.execute("INSERT INTO notes (body) VALUES ('b');")
    })
    await flush()
    const [, first, second] = results
    expect(first && second).toBeTruthy()
    await act(async () => second!.resolve("second"))
    await act(async () => first!.resolve("first"))
    await flush()
    expect(screen.getByText("value: second")).toBeTruthy()
  })

  it("suspends when the key changes", async () => {
    const client = await createClient()
    let setLimit!: (n: number) => void
    const gates = new Map<number, ReturnType<typeof deferred<string>>>()
    const gate = (n: number) => {
      if (!gates.has(n)) gates.set(n, deferred<string>())
      return gates.get(n)!
    }
    gate(1).resolve("page 1")
    function Limited() {
      const [limit, set] = useState(1)
      setLimit = set
      return <p>{`limit: ${useDbQuery(["limited", limit], () => gate(limit).promise)}`}</p>
    }
    const { shown, Fallback } = createFallback()
    await mount(
      <Shell client={Promise.resolve(client)} fallback={<Fallback />}>
        <Limited />
      </Shell>,
    )
    expect(screen.getByText("limit: page 1")).toBeTruthy()
    const before = shown.count
    await act(async () => setLimit(2))
    expect(screen.getByText("loading")).toBeTruthy()
    await act(async () => gate(2).resolve("page 2"))
    expect(screen.getByText("limit: page 2")).toBeTruthy()
    expect(shown.count).toBeGreaterThan(before)
  })

  it("keeps the old data when the key changes inside startTransition", async () => {
    const client = await createClient()
    let setLimit!: (n: number) => void
    const gates = new Map<number, ReturnType<typeof deferred<string>>>()
    const gate = (n: number) => {
      if (!gates.has(n)) gates.set(n, deferred<string>())
      return gates.get(n)!
    }
    gate(1).resolve("page 1")
    function Limited() {
      const [limit, set] = useState(1)
      setLimit = set
      return <p>{`limit: ${useDbQuery(["limited", limit], () => gate(limit).promise)}`}</p>
    }
    const { shown, Fallback } = createFallback()
    await mount(
      <Shell client={Promise.resolve(client)} fallback={<Fallback />}>
        <Limited />
      </Shell>,
    )
    expect(screen.getByText("limit: page 1")).toBeTruthy()
    const before = shown.count
    await act(async () => startTransition(() => setLimit(2)))
    expect(screen.getByText("limit: page 1")).toBeTruthy()
    await act(async () => gate(2).resolve("page 2"))
    expect(screen.getByText("limit: page 2")).toBeTruthy()
    expect(shown.count).toBe(before)
  })

  it("shares one query between components that use the same key", async () => {
    const client = await createClient()
    const run = vi.fn((db: DbClient) => db.select<{ n: number }>("SELECT 1 AS n;"))
    function A() {
      return <p>{`a: ${useDbQuery(["shared"], run)[0]?.n}`}</p>
    }
    function B() {
      return <p>{`b: ${useDbQuery(["shared"], run)[0]?.n}`}</p>
    }
    await mount(
      <Shell client={Promise.resolve(client)}>
        <A />
        <B />
      </Shell>,
    )
    await flush()
    expect(screen.getByText("a: 1")).toBeTruthy()
    expect(screen.getByText("b: 1")).toBeTruthy()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("throws a failed query to the nearest error boundary", async () => {
    const client = await createClient()
    function Broken() {
      useDbQuery(["broken"], (db) => db.select("SELECT * FROM missing;"))
      return null
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await mount(
      <Shell client={Promise.resolve(client)}>
        <Broken />
      </Shell>,
    )
    await flush()
    expect(screen.getByText(/^error: SQL execution failed/)).toBeTruthy()
    spy.mockRestore()
  })

  it("queries once for a failure, and again when the error boundary retries", async () => {
    const client = await createClient()
    let fail = true
    const run = vi.fn(async (db: DbClient) => {
      if (fail) throw new Error("query failed")
      return db.select<{ n: number }>("SELECT 7 AS n;")
    })
    function Flaky() {
      return <p>{`n: ${useDbQuery(["flaky"], run)[0]?.n}`}</p>
    }
    let retry!: () => void
    function Retryable() {
      const [attempt, setAttempt] = useState(0)
      retry = () => setAttempt((n) => n + 1)
      return (
        <Boundary key={attempt}>
          <Suspense fallback={<p>loading</p>}>
            <Flaky />
          </Suspense>
        </Boundary>
      )
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await mount(
      <StrictMode>
        <DatabaseProvider client={Promise.resolve(client)}>
          <Retryable />
        </DatabaseProvider>
      </StrictMode>,
    )
    await flush()
    expect(screen.getByText("error: query failed")).toBeTruthy()
    // React 读到失败以后会再同步重试几次渲染：都读同一个失败的 promise，不会每次都重新查询
    expect(run).toHaveBeenCalledTimes(1)

    fail = false
    await act(async () => retry())
    await flush()
    expect(screen.getByText("n: 7")).toBeTruthy()
    expect(run).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it("stops re-querying after unmount, and leaves no subscriptions behind (StrictMode)", async () => {
    const base = await createClient()
    let active = 0
    const client: DbClient = Object.create(base)
    client.onWrite = (listener) => {
      active++
      const unsubscribe = base.onWrite(listener)
      return () => {
        active--
        unsubscribe()
      }
    }
    const run = vi.fn((db: DbClient) => db.select<{ n: number }>("SELECT COUNT(*) AS n FROM notes;"))
    function Counted() {
      return <p>{`n: ${useDbQuery(["counted"], run)[0]?.n}`}</p>
    }
    const { unmount } = await mount(
      <StrictMode>
        <Shell client={Promise.resolve(client)}>
          <Counted />
        </Shell>
      </StrictMode>,
    )
    await flush()
    // 一个是查询缓存的订阅（跟着 client 走，不取消），一个是组件的订阅
    expect(active).toBe(2)

    unmount()
    expect(active).toBe(1)
    const calls = run.mock.calls.length
    await act(async () => {
      await client.execute("INSERT INTO notes (body) VALUES ('a');")
    })
    await flush()
    expect(run.mock.calls.length).toBe(calls)
  })
})
