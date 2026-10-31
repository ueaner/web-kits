import { describe, expect, it, vi } from "vitest"
import { createDbClient, transactionalExecutor } from "cross-sqlite-client"
import { createMiniProgramAdapter } from "cross-sqlite-client/adapters/miniprogram"
import { ASSETS_DIR, createFakeFileSystem, createFakeWXWebAssembly, type FakeWXWebAssemblyOptions } from "./helpers/fake-miniprogram"

// 有的 iOS 环境的 WXWebAssembly 没有 Module（iPhone 14 Pro、iOS 18.5、微信 8.0.56、基础库 3.7.12；一台 iOS 26 的 iPhone 16 Pro 上有）。
// 微信文档本来也只承诺 instantiate、Memory、Table。Module / Instance 只给回调桩模块用：初始化和读写不该因为缺它们失败，
// 以前 initSqlite3 一上来就查它们，报 "webAssembly is missing Module"，数据库整个打不开。
async function freshEngine(options: FakeWXWebAssemblyOptions) {
  // initSqlite3 进程内只初始化一次：每个用例重新加载模块，拿一个新的引擎
  vi.resetModules()
  const { initSqlite3 } = await import("../dist/index.js")
  const wx = createFakeWXWebAssembly(options)
  return { wx, sqlite3: () => initSqlite3({ webAssembly: wx, assetsDir: ASSETS_DIR }) }
}

describe.each([
  { without: ["Module"] as const, exportLength: "zero" as const },
  { without: ["Module", "Instance"] as const, exportLength: "zero-locked" as const },
])("a WXWebAssembly without $without (iOS, exports $exportLength)", (options) => {
  it("initializes and runs cross-sqlite-client's miniprogram adapter end to end", async () => {
    const { wx, sqlite3 } = await freshEngine(options)
    expect(wx.Module).toBeUndefined()
    const fs = createFakeFileSystem()
    const open = () =>
      createDbClient({
        name: "app",
        adapter: createMiniProgramAdapter({ sqlite3, fs, directory: "/user-data/db", logger: { warn() {}, error() {} } }),
        migrations: [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)"] }],
        migrationOptions: { executor: transactionalExecutor },
      })
    const client = await open()
    await client.execute("BEGIN")
    await client.execute("INSERT INTO items (label) VALUES (?)", ["a"])
    await client.execute("COMMIT")
    await client.close()

    // 快照落盘后重新打开（sqlite3_deserialize）能读回来
    const reopened = await open()
    expect(await reopened.select<{ label: string }>("SELECT label FROM items")).toEqual([{ label: "a" }])
    await reopened.close()
  })
})

describe("a callback on a WXWebAssembly without Module", () => {
  it("says which constructor is missing", async () => {
    // 不模拟 iOS 的导出：只缺 Module 时，装回调的那一步报清楚原因
    const { sqlite3 } = await freshEngine({ without: ["Module"] })
    const s = await sqlite3()
    const db = new s.oo1.DB(":memory:", "c")
    expect(() => db.createFunction("one", () => 1)).toThrow(/WXWebAssembly has no Module/)
    db.close()
  })
})

describe("a runtime missing what initialization needs", () => {
  it("still rejects, naming what is missing", async () => {
    vi.resetModules()
    const { initSqlite3 } = await import("../dist/index.js")
    // Table 的类型是 unknown：设成 undefined 就是"没有"，不用强制转换
    const withoutTable = { ...createFakeWXWebAssembly(), Table: undefined }
    await expect(initSqlite3({ webAssembly: withoutTable, assetsDir: ASSETS_DIR })).rejects.toThrow(/webAssembly is missing Table/)
  })
})
