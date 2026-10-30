import { describe, expect, it, vi } from "vitest"
import { createDbClient, transactionalExecutor } from "cross-sqlite-client"
import { createMiniProgramAdapter } from "cross-sqlite-client/adapters/miniprogram"
import { restoreArity } from "../src/shims"
import { ASSETS_DIR, createFakeFileSystem, createFakeWXWebAssembly, type FakeWXWebAssemblyOptions } from "./helpers/fake-miniprogram"

// iOS 真机的 WXWebAssembly：导出函数的 length 都是 0。glue 的 xWrap 按 length 校验参数个数，
// 不修正就在初始化时抛 "sqlite3_aggregate_context() requires 0 argument(s)."
async function freshEngine(exportLength: FakeWXWebAssemblyOptions["exportLength"]) {
  // initSqlite3 进程内只初始化一次：每种情况重新加载模块，拿一个新的引擎
  vi.resetModules()
  const { initSqlite3 } = await import("../dist/index.js")
  const wx = createFakeWXWebAssembly({ exportLength })
  return () => initSqlite3({ webAssembly: wx, assetsDir: ASSETS_DIR })
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

describe.each(["zero", "zero-locked"] as const)("exported functions with length 0 (iOS devices, %s)", (exportLength) => {
  it("initializes and restores each export's parameter count", async () => {
    const s = await (await freshEngine(exportLength))()
    expect(s.capi.sqlite3_libversion()).toMatch(/^3\./)
    const exports = s.wasm.exports as unknown as Record<string, Function>
    expect(exports.sqlite3_aggregate_context!.length).toBe(2)
    expect(exports.sqlite3_bind_double!.length).toBe(3)
  })

  it("runs cross-sqlite-client's miniprogram adapter end to end", async () => {
    const sqlite3 = await freshEngine(exportLength)
    const adapter = createMiniProgramAdapter({
      sqlite3,
      fs: createFakeFileSystem(),
      directory: "/user-data/db",
      logger: { warn() {}, error() {} },
    })
    const client = await createDbClient({
      name: "app",
      adapter,
      migrations: [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)"] }],
      migrationOptions: { executor: transactionalExecutor },
    })
    await client.execute("INSERT INTO items (label) VALUES (?)", ["a"])
    expect(await client.select<{ label: string; n: number }>("SELECT label, count(*) AS n FROM items GROUP BY label")).toEqual([
      { label: "a", n: 1 },
    ])
    await client.close()
  })
})
