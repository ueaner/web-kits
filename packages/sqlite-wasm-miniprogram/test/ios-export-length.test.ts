import { describe, expect, it, vi } from "vitest"
import { createDbClient, transactionalExecutor } from "cross-sqlite-client"
import { createMiniProgramAdapter } from "cross-sqlite-client/adapters/miniprogram"
import { restoreArity } from "../src/shims"
import { ASSETS_DIR, createFakeFileSystem, createFakeWXWebAssembly, type FakeWXWebAssemblyOptions } from "./helpers/fake-miniprogram"

// iOS 真机的 WXWebAssembly（web-kits#10）：导出的是 JS 包装函数，不是 wasm 函数。
// ① length 都是 0：glue 的 xWrap 按 length 校验参数个数，不修正就在初始化时抛 "sqlite3_aggregate_context() requires 0 argument(s)."；
// ② 函数表不收：glue 初始化时把 JS VFS 的方法和 SQL trace 回调装进函数表，装一个就失败。
async function freshEngine(exportLength: FakeWXWebAssemblyOptions["exportLength"]) {
  // initSqlite3 进程内只初始化一次：每种情况重新加载模块，拿一个新的引擎
  vi.resetModules()
  const { initSqlite3 } = await import("../dist/index.js")
  const wx = createFakeWXWebAssembly({ exportLength })
  return { wx, sqlite3: () => initSqlite3({ webAssembly: wx, assetsDir: ASSETS_DIR }) }
}

describe("restoreArity", () => {
  it("fixes only a length of 0 and trusts a non-zero length the host reports", () => {
    function zero(..._args: unknown[]) {}
    function reported(_a: unknown) {}
    const exports = restoreArity({ zero, reported }, { zero: 2, reported: 3 })
    expect((exports.zero as Function).length).toBe(2)
    // 包内的 sqlite3.wasm 和 glue 版本对不上时，宿主报的才是真的：不拿构建时的表覆盖
    expect((exports.reported as Function).length).toBe(1)
  })
})

describe.each(["zero", "zero-locked"] as const)("exports that are JS wrappers (iOS devices, %s)", (exportLength) => {
  it("initializes without installing any callback and restores each export's parameter count", async () => {
    const { wx, sqlite3 } = await freshEngine(exportLength)
    const s = await sqlite3()
    expect(s.capi.sqlite3_libversion()).toMatch(/^3\./)
    const exports = s.wasm.exports as unknown as Record<string, Function>
    expect(exports.sqlite3_aggregate_context!.length).toBe(2)
    expect(exports.sqlite3_bind_double!.length).toBe(3)
    // 回调要靠桩模块进函数表，桩模块一个都没建：初始化没有装回调
    expect(wx.moduleCalls).toEqual([])
  })

  it("runs cross-sqlite-client's miniprogram adapter end to end", async () => {
    const { wx, sqlite3 } = await freshEngine(exportLength)
    const fs = createFakeFileSystem()
    const open = () =>
      createDbClient({
        name: "app",
        adapter: createMiniProgramAdapter({ sqlite3, fs, directory: "/user-data/db", logger: { warn() {}, error() {} } }),
        migrations: [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, key TEXT UNIQUE)"] }],
        migrationOptions: { executor: transactionalExecutor },
      })
    const client = await open()
    await client.execute("BEGIN")
    await client.execute("INSERT INTO items (label, key) VALUES (?, ?)", ["a", "k"])
    await client.execute("COMMIT")
    const again = await client.execute("INSERT INTO items (label, key) SELECT ?, ? WHERE true ON CONFLICT (key) DO NOTHING", ["a", "k"])
    expect(again.rowsAffected).toBe(0)
    await client.close()

    // 快照落盘后重新打开（sqlite3_deserialize）能读回来
    const reopened = await open()
    expect(await reopened.select<{ label: string; n: number }>("SELECT label, count(*) AS n FROM items GROUP BY label")).toEqual([
      { label: "a", n: 1 },
    ])
    await reopened.close()
    expect(wx.moduleCalls).toEqual([])
  })

  it("still can't install a callback: opening with the trace flag fails (a documented iOS limitation)", async () => {
    const { sqlite3 } = await freshEngine(exportLength)
    const s = await sqlite3()
    expect(() => new s.oo1.DB(":memory:", "ct")).toThrow()
    // 不带 t 的照常能开
    new s.oo1.DB(":memory:", "c").close()
  })
})
