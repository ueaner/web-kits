import { describe, expect, it } from "vitest"
import { ASSETS_DIR, createFakeFileSystem, createFakeWXWebAssembly } from "./helpers/fake-miniprogram"

// 真机上的小程序 / 小游戏没有 TextEncoder / TextDecoder（开发者工具里有，所以只在模拟器里测过的 0.1.0 在真机上打不开数据库：
// "Exception loading sqlite3 module: TextDecoder is not defined"）。这里先删掉它们，再加载构建产物。
// 单独一个文件：vitest 每个文件一个模块实例，引擎在这个文件里是第一次初始化
describe("the built engine where the runtime has no TextEncoder / TextDecoder (real devices)", () => {
  it("opens, writes and reads back non-ASCII text", async () => {
    const saved = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder }
    delete (globalThis as Partial<typeof globalThis>).TextEncoder
    delete (globalThis as Partial<typeof globalThis>).TextDecoder
    try {
      const { initSqlite3 } = await import("../dist/index.js")
      const { createDbClient } = await import("cross-sqlite-client")
      const { createMiniProgramAdapter } = await import("cross-sqlite-client/adapters/miniprogram")
      const sqlite3 = () => initSqlite3({ webAssembly: createFakeWXWebAssembly(), assetsDir: ASSETS_DIR })
      const adapter = createMiniProgramAdapter({
        sqlite3,
        fs: createFakeFileSystem(),
        directory: "/user-data/db",
        logger: { warn() {}, error() {} },
      })
      const client = await createDbClient({
        name: "app",
        adapter,
        migrations: [{ version: 1, statements: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"] }],
      })
      const text = "数独 · 第 1 局 🎉 ok"
      await client.execute("INSERT INTO notes (body) VALUES (?)", [text])
      expect(await client.select<{ body: string; n: number }>("SELECT body, length(body) AS n FROM notes")).toEqual([
        { body: text, n: [...text].length },
      ])
      expect(typeof globalThis.TextDecoder).toBe("undefined") // 没有往全局上挂东西
      await client.close()
    } finally {
      Object.assign(globalThis, saved)
    }
  })
})
