import { describe, expect, it, vi } from "vitest"
import { createDbClient } from "../src/core/index"
import { createMemoryAdapter } from "../src/adapters/memory"
import type { Logger } from "../src/core/types"

const MIGRATIONS = [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);"] }]

const silentLogger = () => ({ warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() })

async function setup(logger: Logger = silentLogger()) {
  const client = await createDbClient({ name: "test", adapter: createMemoryAdapter(), migrations: MIGRATIONS, logger })
  const listener = vi.fn()
  client.onWrite(listener)
  return { client, listener }
}

/** 等通知的微任务跑完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("onWrite", () => {
  it("notifies after execute() and executeBatch()", async () => {
    const { client, listener } = await setup()
    await client.execute("INSERT INTO items (label) VALUES ('a');")
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)

    await client.executeBatch(["INSERT INTO items (label) VALUES ('b');", { sql: "INSERT INTO items (label) VALUES (?);", params: ["c"] }])
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("notifies when a write fails, because executeBatch may have applied earlier statements", async () => {
    const { client, listener } = await setup()
    await expect(
      client.executeBatch([{ sql: "INSERT INTO items (label) VALUES (?);", params: ["a"] }, "INSERT INTO missing VALUES (1);"]),
    ).rejects.toThrow()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(await client.select("SELECT label FROM items;")).toEqual([{ label: "a" }])
  })

  it("does not notify for select()", async () => {
    const { client, listener } = await setup()
    await client.select("SELECT * FROM items;")
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })

  it("does not notify for the migrations createDbClient ran", async () => {
    const { listener } = await setup()
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })

  it("notifies after the write's promise settles, not before", async () => {
    const { client, listener } = await setup()
    const write = client.execute("INSERT INTO items (label) VALUES ('a');")
    expect(listener).not.toHaveBeenCalled()
    await write
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("merges writes started in the same task into one notification", async () => {
    const { client, listener } = await setup()
    await Promise.all([
      client.execute("INSERT INTO items (label) VALUES ('a');"),
      client.execute("INSERT INTO items (label) VALUES ('b');"),
      client.execute("INSERT INTO items (label) VALUES ('c');"),
    ])
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("notifies once per write when writes are awaited one after another", async () => {
    const { client, listener } = await setup()
    await client.execute("INSERT INTO items (label) VALUES ('a');")
    await settle()
    await client.execute("INSERT INTO items (label) VALUES ('b');")
    await settle()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("stops notifying after unsubscribe", async () => {
    const { client, listener } = await setup()
    const other = vi.fn()
    const unsubscribe = client.onWrite(other)
    unsubscribe()
    await client.execute("INSERT INTO items (label) VALUES ('a');")
    await settle()
    expect(other).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("reports a throwing listener to the logger and still notifies the others", async () => {
    const logger = silentLogger()
    const { client, listener } = await setup(logger)
    const boom = new Error("boom")
    client.onWrite(() => {
      throw boom
    })
    const after = vi.fn()
    client.onWrite(after)

    await expect(client.execute("INSERT INTO items (label) VALUES ('a');")).resolves.toBeDefined()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), boom)
  })

  it("stops notifying after close()", async () => {
    const { client, listener } = await setup()
    // 写入还没结束就关闭：之后写入结束，也不再通知
    const write = client.execute("INSERT INTO items (label) VALUES ('a');")
    const closing = client.close()
    await write
    await closing
    // 关闭以后的写入会失败，同样不通知
    await expect(client.execute("INSERT INTO items (label) VALUES ('b');")).rejects.toThrow()
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })

  it("forwards storage as a getter (it changes on close)", async () => {
    const { client } = await setup()
    expect(client.storage).toEqual({ persistent: false, reason: "memory-adapter" })
    await client.close()
    expect(client.storage).toEqual({ persistent: false, reason: "not-initialized" })
  })
})

describe("groupWrites", () => {
  it("holds notifications until fn finishes, then notifies once", async () => {
    const { client, listener } = await setup()
    await client.groupWrites(async () => {
      await client.execute("BEGIN;")
      await client.execute("INSERT INTO items (label) VALUES ('a');")
      await settle()
      expect(listener).not.toHaveBeenCalled()
      await client.execute("INSERT INTO items (label) VALUES ('b');")
      await client.execute("COMMIT;")
      await settle()
      expect(listener).not.toHaveBeenCalled()
    })
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("returns fn's value", async () => {
    const { client } = await setup()
    await expect(client.groupWrites(async () => 42)).resolves.toBe(42)
  })

  it("still notifies, and rethrows, when fn throws", async () => {
    const { client, listener } = await setup()
    const error = new Error("rollback")
    await expect(
      client.groupWrites(async () => {
        await client.execute("INSERT INTO items (label) VALUES ('a');")
        throw error
      }),
    ).rejects.toBe(error)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("notifies only when the outermost group finishes", async () => {
    const { client, listener } = await setup()
    await client.groupWrites(async () => {
      await client.groupWrites(async () => {
        await client.execute("INSERT INTO items (label) VALUES ('a');")
      })
      await settle()
      expect(listener).not.toHaveBeenCalled()
      await client.execute("INSERT INTO items (label) VALUES ('b');")
    })
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("does not notify when fn wrote nothing", async () => {
    const { client, listener } = await setup()
    await client.groupWrites(async () => {
      await client.select("SELECT 1;")
    })
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })
})
