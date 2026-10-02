import { describe, expect, it } from "vitest"
import { createDbClient } from "../src/core/index"
import { createMemoryAdapter } from "../src/adapters/memory"
import { DbError, DbInitializationError } from "../src/core/errors"

const MIGRATIONS = [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);"] }]

async function createClient() {
  return createDbClient({ name: "test", adapter: createMemoryAdapter(), migrations: MIGRATIONS })
}

describe("storage", () => {
  it("is never persistent on the memory adapter", async () => {
    const client = await createClient()
    expect(client.storage).toEqual({ persistent: false, reason: "memory-adapter" })
    await client.close()
    expect(client.storage).toEqual({ persistent: false, reason: "not-initialized" })
  })
})

describe("executeBatch", () => {
  it("runs multiple parameterless statements", async () => {
    const client = await createClient()
    await client.executeBatch(["INSERT INTO items (label) VALUES ('a');", "INSERT INTO items (label) VALUES ('b');"])

    const rows = await client.select<{ label: string }>("SELECT label FROM items ORDER BY id;")
    expect(rows).toEqual([{ label: "a" }, { label: "b" }])
  })

  it("runs statements with bound params", async () => {
    const client = await createClient()
    await client.executeBatch([
      { sql: "INSERT INTO items (label) VALUES (?);", params: ["a"] },
      "INSERT INTO items (label) VALUES ('b');",
      { sql: "UPDATE items SET label = ? WHERE label = 'b';", params: ["c"] },
    ])

    const rows = await client.select<{ label: string }>("SELECT label FROM items ORDER BY id;")
    expect(rows).toEqual([{ label: "a" }, { label: "c" }])
  })

  it("accepts statements without trailing semicolons", async () => {
    const client = await createClient()
    // 逐条 execute() 时不需要分号；拼接优化路径也不能因此对无分号语句报错
    await client.executeBatch(["INSERT INTO items (label) VALUES ('a')", "INSERT INTO items (label) VALUES ('b') -- trailing comment"])

    const rows = await client.select<{ label: string }>("SELECT label FROM items ORDER BY id;")
    expect(rows).toEqual([{ label: "a" }, { label: "b" }])
  })
})

describe("pragmas", () => {
  it("applies pragmas before migrations", async () => {
    const client = await createDbClient({
      name: "test",
      adapter: createMemoryAdapter(),
      migrations: MIGRATIONS,
      pragmas: { foreign_keys: true },
    })

    const rows = await client.select<{ foreign_keys: number }>("PRAGMA foreign_keys;")
    expect(rows[0]?.foreign_keys).toBe(1)
  })

  it("rejects an invalid pragma name", async () => {
    await expect(
      createDbClient({
        name: "test",
        adapter: createMemoryAdapter(),
        pragmas: { "foreign_keys; DROP TABLE items;--": 1 },
      }),
    ).rejects.toThrow(/PRAGMA name/)
  })

  it("rejects an invalid pragma string value", async () => {
    await expect(
      createDbClient({
        name: "test",
        adapter: createMemoryAdapter(),
        pragmas: { journal_mode: "WAL; DROP TABLE items;--" },
      }),
    ).rejects.toThrow(/PRAGMA journal_mode/)
  })
})

describe("initialize concurrency", () => {
  it("returns the same client for concurrent initialize() calls", async () => {
    const adapter = createMemoryAdapter()
    const [a, b] = await Promise.all([adapter.initialize({ name: "test" }), adapter.initialize({ name: "test" })])
    expect(a).toBe(b)
  })

  it("shares one in-flight createDbClient setup across concurrent initialize() calls", async () => {
    // 迁移只应执行一次：若并发初始化各自跑了一遍完整流程，第二条 INSERT INTO schema_version
    // 会因 version 主键冲突而抛错
    const adapter = createMemoryAdapter()
    const [client, connection] = await Promise.all([
      createDbClient({ name: "test", adapter, migrations: MIGRATIONS }),
      adapter.initialize({ name: "test" }),
    ])
    // createDbClient 返回的是包了写入通知的 client，底下是同一条连接：一边写入，另一边能读到
    await client.execute("INSERT INTO items (label) VALUES ('a');")
    expect(await connection.select<{ label: string }>("SELECT label FROM items;")).toEqual([{ label: "a" }])
  })
})

describe("migration executor", () => {
  it("runs migration statements through executeBatch by default", async () => {
    const adapter = createMemoryAdapter()
    let batchCalls = 0
    const realInitialize = adapter.initialize.bind(adapter)
    adapter.initialize = async (config) => {
      const client = await realInitialize(config)
      const realBatch = client.executeBatch.bind(client)
      client.executeBatch = async (statements) => {
        batchCalls += 1
        await realBatch(statements)
      }
      return client
    }

    await createDbClient({ name: "test", adapter, migrations: MIGRATIONS })
    expect(batchCalls).toBe(1)
  })
})

describe("client lifecycle", () => {
  it("throws DbError when calling executeBatch() after close()", async () => {
    const client = await createClient()
    await client.close()

    const error = await client.executeBatch(["SELECT 1;"]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbError)
  })

  it("re-opens a fresh working connection when initialize() is called after close()", async () => {
    const adapter = createMemoryAdapter()
    const client = await adapter.initialize({ name: "test" })
    await client.close()

    const reopened = await adapter.initialize({ name: "test" })
    // close() 会清掉缓存的初始化 Promise，重开得到的是全新可用连接而不是死 client
    expect(await reopened.select<{ n: number }>("SELECT 1 AS n;")).toEqual([{ n: 1 }])
  })
})

describe("signal", () => {
  it("passes createDbClient's signal to the adapter: an aborted one stops initialization", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    const error = await createDbClient({ name: "test", adapter: createMemoryAdapter(), signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbInitializationError)
    expect((error as DbInitializationError).cause).toBe(controller.signal.reason)
  })
})
