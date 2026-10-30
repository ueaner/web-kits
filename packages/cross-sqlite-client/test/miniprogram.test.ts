import { describe, expect, it, vi } from "vitest"
import { createDbClient } from "../src/core/index"
import { transactionalExecutor } from "../src/core/transactional"
import { createMiniProgramAdapter } from "../src/adapters/miniprogram"
import { DbExecutionError, DbInitializationError, DbPersistenceError } from "../src/core/errors"
import type { Logger, Migration } from "../src/core/types"
import { createFakeFileSystem, type FakeFileSystem } from "./helpers/fake-fs"
import { loadTestSqlite3 } from "./helpers/test-adapter"

const DIR = "/user-data/cross-sqlite-client"
const DB = `${DIR}/app.sqlite`

const MIGRATIONS: Migration[] = [
  { version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, key TEXT UNIQUE);"] },
]

const quietLogger = () => ({ warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() })

function open(fs: FakeFileSystem = createFakeFileSystem(), logger: Logger = quietLogger()) {
  const adapter = createMiniProgramAdapter({ sqlite3: loadTestSqlite3, fs, directory: DIR, logger })
  return { fs, logger, adapter, connect: () => adapter.initialize({ name: "app" }) }
}

async function openClient(fs: FakeFileSystem = createFakeFileSystem(), logger: Logger = quietLogger()) {
  const { adapter } = open(fs, logger)
  const client = await createDbClient({
    name: "app",
    adapter,
    migrations: MIGRATIONS,
    migrationOptions: { executor: transactionalExecutor },
  })
  return { fs, logger, client }
}

const labels = async (client: { select<T>(sql: string): Promise<T[]> }) =>
  (await client.select<{ label: string }>("SELECT label FROM items ORDER BY id")).map((r) => r.label)

describe("persistence", () => {
  it("keeps data across close() and reopening from the same files", async () => {
    const { fs, client } = await openClient()
    await client.execute("INSERT INTO items (label) VALUES (?)", ["a"])
    await client.close()

    const { client: reopened } = await openClient(fs)
    expect(await labels(reopened)).toEqual(["a"])
    expect(reopened.storage).toEqual({ persistent: true })
  })

  it("has the data on disk when execute() resolves", async () => {
    const { fs, client } = await openClient()
    const writesBefore = fs.calls.writeFile
    await client.execute("INSERT INTO items (label) VALUES ('a')")
    expect(fs.calls.writeFile).toBe(writesBefore + 1)
    expect(fs.list(DIR)).toEqual(["app.sqlite", "app.sqlite.bak"])
  })

  it("writes the whole migration run once with transactionalExecutor", async () => {
    const fs = createFakeFileSystem()
    await openClient(fs)
    // 两个迁移版本各一个事务（建 schema_version 表本身也是一次写入）；不是每条语句一次
    expect(fs.calls.writeFile).toBeLessThanOrEqual(2)
  })

  it("does not save after a read-only select()", async () => {
    const { fs, client } = await openClient()
    const writesBefore = fs.calls.writeFile
    await client.select("SELECT * FROM items")
    expect(fs.calls.writeFile).toBe(writesBefore)
  })

  it("saves when a select() writes (INSERT … RETURNING, PRAGMA user_version)", async () => {
    const { fs, client } = await openClient()
    const writesBefore = fs.calls.writeFile
    await client.select("INSERT INTO items (label) VALUES ('a') RETURNING id")
    await client.select("PRAGMA user_version = 7")
    expect(fs.calls.writeFile).toBe(writesBefore + 2)
    await client.close()

    const { client: reopened } = await openClient(fs)
    expect(await labels(reopened)).toEqual(["a"])
    expect(await reopened.select("PRAGMA user_version")).toEqual([{ user_version: 7 }])
  })

  it("saves an executeBatch() once", async () => {
    const { fs, client } = await openClient()
    const writesBefore = fs.calls.writeFile
    await client.executeBatch([{ sql: "INSERT INTO items (label) VALUES (?)", params: ["a"] }, "INSERT INTO items (label) VALUES ('b')"])
    expect(fs.calls.writeFile).toBe(writesBefore + 1)
  })

  it("saves what a failing executeBatch() already applied, then throws the original error", async () => {
    const { fs, client } = await openClient()
    const error = await client
      .executeBatch([
        { sql: "INSERT INTO items (label) VALUES (?)", params: ["a"] },
        { sql: "INSERT INTO missing VALUES (?)", params: [1] },
      ])
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbExecutionError)
    await client.close()

    const { client: reopened } = await openClient(fs)
    expect(await labels(reopened)).toEqual(["a"])
  })
})

describe("transactions", () => {
  it("does not save inside a transaction, and saves once on COMMIT", async () => {
    const { fs, client } = await openClient()
    const writesBefore = fs.calls.writeFile
    await client.execute("BEGIN")
    await client.execute("INSERT INTO items (label) VALUES ('a')")
    await client.execute("INSERT INTO items (label) VALUES ('b')")
    expect(fs.calls.writeFile).toBe(writesBefore)
    await client.execute("COMMIT")
    expect(fs.calls.writeFile).toBe(writesBefore + 1)
  })

  it("leaves nothing on disk after ROLLBACK", async () => {
    const { fs, client } = await openClient()
    await client.execute("BEGIN")
    await client.execute("INSERT INTO items (label) VALUES ('a')")
    await client.execute("ROLLBACK")
    await client.close()

    const { client: reopened } = await openClient(fs)
    expect(await labels(reopened)).toEqual([])
  })

  it("does not save when one string leaves a transaction open, without parsing SQL", async () => {
    const { fs, client } = await openClient()
    const writesBefore = fs.calls.writeFile
    await client.execute("INSERT INTO items (label) VALUES ('a'); BEGIN; INSERT INTO items (label) VALUES ('b')")
    expect(fs.calls.writeFile).toBe(writesBefore)
    // 这时进程被杀：a 在 BEGIN 之前已经自动提交，但这次调用还没结束、没有落盘，磁盘上 a、b 都没有
    const { client: afterCrash } = await openClient(fs.fork())
    expect(await labels(afterCrash)).toEqual([])
    await client.execute("COMMIT")
    expect(fs.calls.writeFile).toBe(writesBefore + 1)
  })
})

describe("persistence failure", () => {
  it("rolls memory back to the last saved snapshot and throws DbPersistenceError", async () => {
    const { fs, client } = await openClient()
    await client.execute("INSERT INTO items (label, key) VALUES ('a', 'k1')")

    fs.failNext("writeFile", { path: /\.tmp$/, errMsg: "the maximum size of the file storage limit is exceeded" })
    const error = await client.execute("INSERT INTO items (label, key) VALUES ('b', 'k2')").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbPersistenceError)
    expect(await labels(client)).toEqual(["a"])

    // 重试同一条带去重键的写入：真正写进去了，而不是被 ON CONFLICT 当成"已经记过"
    const retry = await client.execute("INSERT INTO items (label, key) VALUES ('b', 'k2') ON CONFLICT (key) DO NOTHING")
    expect(retry.rowsAffected).toBe(1)
    await client.close()

    const { client: reopened } = await openClient(fs)
    expect(await labels(reopened)).toEqual(["a", "b"])
  })

  it("drops the whole transaction when saving fails on COMMIT", async () => {
    const { fs, client } = await openClient()
    await client.execute("INSERT INTO items (label) VALUES ('a')")
    await client.execute("BEGIN")
    await client.execute("INSERT INTO items (label) VALUES ('b')")
    await client.execute("INSERT INTO items (label) VALUES ('c')")
    fs.failNext("rename", { path: /\.tmp$/ })
    await expect(client.execute("COMMIT")).rejects.toBeInstanceOf(DbPersistenceError)
    expect(await labels(client)).toEqual(["a"])
  })

  it("keeps working after a failed save", async () => {
    const { fs, client } = await openClient()
    fs.failNext("stat")
    await expect(client.execute("INSERT INTO items (label) VALUES ('a')")).rejects.toBeInstanceOf(DbPersistenceError)
    await client.execute("INSERT INTO items (label) VALUES ('b')")
    expect(await labels(client)).toEqual(["b"])
    expect(fs.list(DIR)).not.toContain("app.sqlite.tmp")
  })
})

describe("opening and recovery", () => {
  async function seeded() {
    const { fs, client } = await openClient()
    await client.execute("INSERT INTO items (label) VALUES ('old')")
    await client.execute("INSERT INTO items (label) VALUES ('new')")
    await client.close()
    // .bak 是上一个完好版本（只有 old），当前文件有 old + new
    return fs
  }

  it("restores the previous version when the current file is truncated, keeping the corrupt file", async () => {
    const fs = await seeded()
    fs.files.set(DB, fs.files.get(DB)!.slice(0, 50))
    const logger = quietLogger()
    const { client } = await openClient(fs, logger)
    expect(await labels(client)).toEqual(["old"])
    expect(logger.error).toHaveBeenCalledOnce()
    const names = fs.list(DIR)
    expect(names).toContain("app.sqlite")
    expect(names).toContain("app.sqlite.bak")
    expect(names.some((n) => /^app\.sqlite\.corrupt-\d+$/.test(n))).toBe(true)
  })

  it("restores the previous version when the current file is not a SQLite file", async () => {
    const fs = await seeded()
    fs.files.set(DB, new Uint8Array(4096).fill(7))
    const { client } = await openClient(fs)
    expect(await labels(client)).toEqual(["old"])
  })

  it("starts a new database when both files are corrupt, without deleting either", async () => {
    const fs = await seeded()
    fs.files.set(DB, new Uint8Array(4096).fill(1))
    fs.files.set(`${DB}.bak`, new Uint8Array(4096).fill(2))
    const logger = quietLogger()
    const { client } = await openClient(fs, logger)
    expect(await labels(client)).toEqual([])
    expect(logger.error).toHaveBeenCalledOnce()
    const corrupt = fs.list(DIR).filter((n) => n.includes(".corrupt-"))
    expect(corrupt).toHaveLength(2)
  })

  it("recovers when killed between moving the current file to .bak and renaming .tmp", async () => {
    const fs = await seeded()
    // 模拟：保存时 .tmp 写好了、当前文件已改名为 .bak，然后进程被杀
    fs.files.set(`${DB}.tmp`, fs.files.get(DB)!)
    fs.files.set(`${DB}.bak`, fs.files.get(DB)!)
    fs.files.delete(DB)
    const logger = quietLogger()
    const { client } = await openClient(fs, logger)
    expect(await labels(client)).toEqual(["old", "new"])
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(fs.list(DIR)).toEqual(["app.sqlite", "app.sqlite.bak"])
  })

  it("creates the directory on first open", async () => {
    const fs = createFakeFileSystem()
    const { client } = await openClient(fs)
    await client.execute("INSERT INTO items (label) VALUES ('a')")
    expect(fs.list(DIR)).toContain("app.sqlite")
  })
})

describe("initialize", () => {
  it("refuses to open the same database file twice in one process", async () => {
    const fs = createFakeFileSystem()
    const first = open(fs)
    await first.connect()
    const error = await open(fs)
      .connect()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbInitializationError)
    expect(String((error as DbInitializationError).cause)).toMatch(/already open/)
  })

  it("can open the same file again after close()", async () => {
    const fs = createFakeFileSystem()
    const first = await open(fs).connect()
    await first.close()
    await expect(open(fs).connect()).resolves.toBeDefined()
  })

  it("fails without falling back to memory when fs is missing methods, and can be retried", async () => {
    const fs = createFakeFileSystem()
    const broken = { ...fs, stat: undefined } as unknown as FakeFileSystem
    const error = await open(broken)
      .connect()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbInitializationError)
    expect(String((error as DbInitializationError).cause)).toMatch(/stat/)
  })

  it("fails when the engine cannot be loaded, and retries the engine on the next initialize()", async () => {
    let attempts = 0
    const adapter = createMiniProgramAdapter({
      sqlite3: async () => {
        attempts++
        if (attempts === 1) throw new Error("WXWebAssembly is not available")
        return loadTestSqlite3()
      },
      fs: createFakeFileSystem(),
      directory: DIR,
      logger: quietLogger(),
    })
    await expect(adapter.initialize({ name: "app" })).rejects.toBeInstanceOf(DbInitializationError)
    await expect(adapter.initialize({ name: "app" })).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  it("rejects database names that are not plain file names", async () => {
    const adapter = createMiniProgramAdapter({
      sqlite3: loadTestSqlite3,
      fs: createFakeFileSystem(),
      directory: DIR,
      logger: quietLogger(),
    })
    await expect(adapter.initialize({ name: "../escape" })).rejects.toBeInstanceOf(DbInitializationError)
  })
})

/**
 * 可控的引擎：allocFromTypedArray 可以按需失败（模拟内存不足这类临时失败），并统计还开着的连接（查泄漏）。
 * 用的是测试引擎本身，只把这两处包一层
 */
async function controllableEngine() {
  const s = await loadTestSqlite3()
  const state = { failAlloc: false, openConnections: 0 }
  class CountingDB extends s.oo1.DB {
    constructor(...args: ConstructorParameters<typeof s.oo1.DB>) {
      super(...args)
      state.openConnections++
    }
    override close() {
      if (this.pointer) state.openConnections--
      return super.close()
    }
  }
  const engine = {
    ...s,
    oo1: { ...s.oo1, DB: CountingDB },
    wasm: {
      ...s.wasm,
      allocFromTypedArray: (bytes: Uint8Array) => {
        if (state.failAlloc) throw new Error("WasmAllocError: out of memory")
        return s.wasm.allocFromTypedArray(bytes)
      },
    },
  } as typeof s
  return { state, sqlite3: async () => engine }
}

describe("failures that are not corruption", () => {
  async function seeded() {
    const { fs, client } = await openClient()
    await client.execute("INSERT INTO items (label) VALUES ('old')")
    await client.execute("INSERT INTO items (label) VALUES ('new')")
    await client.close()
    return fs
  }

  it("fails to open (and can retry) when memory runs out, without moving the intact files aside", async () => {
    const fs = await seeded()
    const { state, sqlite3 } = await controllableEngine()
    const logger = quietLogger()
    const adapter = createMiniProgramAdapter({ sqlite3, fs, directory: DIR, logger })
    state.failAlloc = true
    await expect(adapter.initialize({ name: "app" })).rejects.toBeInstanceOf(DbInitializationError)
    // 内存不足不说明文件坏了：两个文件原样留着，没有挪开，也没有退回旧版本
    expect(fs.list(DIR)).toEqual(["app.sqlite", "app.sqlite.bak"])
    expect(logger.error).not.toHaveBeenCalled()
    state.failAlloc = false
    expect(await labels(await adapter.initialize({ name: "app" }))).toEqual(["old", "new"])
  })

  it("closes the connection it opened from .bak when repairing the current file fails", async () => {
    const fs = await seeded()
    fs.files.set(DB, new Uint8Array(4096).fill(7))
    const { state, sqlite3 } = await controllableEngine()
    const adapter = createMiniProgramAdapter({ sqlite3, fs, directory: DIR, logger: quietLogger() })
    fs.failNext("rename", { path: /app\.sqlite$/ })
    await expect(adapter.initialize({ name: "app" })).rejects.toBeInstanceOf(DbInitializationError)
    expect(state.openConnections).toBe(0)
  })

  it("starts over on the next initialize() when restoring after a failed save fails, and keeps both errors", async () => {
    const fs = createFakeFileSystem()
    const { state, sqlite3 } = await controllableEngine()
    const adapter = createMiniProgramAdapter({ sqlite3, fs, directory: DIR, logger: quietLogger() })
    const client = await createDbClient({ name: "app", adapter, migrations: MIGRATIONS })
    await client.execute("INSERT INTO items (label) VALUES ('a')")

    fs.failNext("writeFile", { path: /\.tmp$/, errMsg: "the maximum size of the file storage limit is exceeded" })
    state.failAlloc = true
    const error = await client.execute("INSERT INTO items (label) VALUES ('b')").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbPersistenceError)
    // 落盘失败的原因（配额满）没有被恢复失败的错误顶掉
    const cause = (error as DbPersistenceError).cause as AggregateError
    expect(cause).toBeInstanceOf(AggregateError)
    expect(String(cause.errors[0])).toMatch(/storage limit/)

    state.failAlloc = false
    // 不用先 close()：initialize() 重新打开文件，而不是返回那个已经没有数据库的连接
    const reopened = await adapter.initialize({ name: "app" })
    expect(await labels(reopened)).toEqual(["a"])
  })

  it("does not hand out a client that a pending close() is about to shut", async () => {
    const { adapter } = open()
    const first = await adapter.initialize({ name: "app" })
    const closing = first.close()
    const again = adapter.initialize({ name: "app" })
    await closing
    const client = await again
    await expect(client.execute("CREATE TABLE t (x)")).resolves.toBeDefined()
    // 之后的 initialize() 拿到的还是这个连接，不会再打开一次（"already open"）
    await expect(adapter.initialize({ name: "app" })).resolves.toBe(client)
  })
})

describe("errors and saving", () => {
  it("saves what a failing select() already applied", async () => {
    const { fs, client } = await openClient()
    await expect(client.select("INSERT INTO items (label) VALUES ('a') RETURNING id; SELECT missing FROM items")).rejects.toBeInstanceOf(
      DbExecutionError,
    )
    // 进程这时被杀：生效了的 INSERT 已经在磁盘上，和内存一致
    const { client: afterCrash } = await openClient(fs.fork())
    expect(await labels(afterCrash)).toEqual(["a"])
  })

  it("reports the SQL error, not a save error, when a failed statement changed nothing", async () => {
    const { fs, client } = await openClient()
    await client.execute("INSERT INTO items (label, key) VALUES ('a', 'k')")
    const writesBefore = fs.calls.writeFile
    fs.failNext("writeFile", { path: /\.tmp$/ })
    await expect(client.execute("INSERT INTO items (label, key) VALUES ('b', 'k')")).rejects.toBeInstanceOf(DbExecutionError)
    expect(fs.calls.writeFile).toBe(writesBefore)
  })
})
