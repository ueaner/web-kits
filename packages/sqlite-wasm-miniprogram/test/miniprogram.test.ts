import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createDbClient, transactionalExecutor } from "cross-sqlite-client"
import { createMiniProgramAdapter } from "cross-sqlite-client/adapters/miniprogram"
// 测的是构建产物：注入了垫片的 glue 只存在于 dist/ 里
import { initSqlite3 } from "../dist/index.js"
import { ASSETS_DIR, createFakeFileSystem, createFakeWXWebAssembly } from "./helpers/fake-miniprogram"

const wx = createFakeWXWebAssembly()
const sqlite3 = () => initSqlite3({ webAssembly: wx, assetsDir: ASSETS_DIR })
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "dist", "assets", "manifest.json"), "utf8")) as {
  sqlite: string
  stubs: string[]
}

const MIGRATIONS = [{ version: 1, statements: ["CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, key TEXT UNIQUE)"] }]

async function openClient(fs = createFakeFileSystem()) {
  const adapter = createMiniProgramAdapter({ sqlite3, fs, directory: "/user-data/db", logger: { warn() {}, error() {} } })
  const client = await createDbClient({
    name: "app",
    adapter,
    migrations: MIGRATIONS,
    migrationOptions: { executor: transactionalExecutor },
  })
  return { fs, client }
}

describe("initSqlite3 in a simulated mini program", () => {
  it("loads sqlite3.wasm.br through the WXWebAssembly stand-in", async () => {
    const s = await sqlite3()
    expect(s.capi.sqlite3_libversion()).toBe(manifest.sqlite)
  })

  it("returns the same engine on later calls", async () => {
    expect(await sqlite3()).toBe(await sqlite3())
  })

  it("creates callback stubs only from the prebuilt files", async () => {
    await sqlite3()
    // 初始化时 glue 用到的回调都走了 stubs/ 里的预生成文件（模拟的 Module 不接受字节）
    expect(wx.moduleCalls.length).toBeGreaterThan(0)
    for (const path of wx.moduleCalls) {
      expect(path).toMatch(/^\/sqlite\/stubs\/[0-9a-f]+\.wasm$/)
      expect(manifest.stubs).toContain(path.slice("/sqlite/stubs/".length, -".wasm".length))
    }
  })

  it("names the missing stub when a callback signature was not prebuilt", async () => {
    const s = (await sqlite3()) as unknown as { wasm: { jsFuncToWasm(fn: () => number, sig: string): unknown } }
    expect(() => s.wasm.jsFuncToWasm(() => 0, "i(pppppppppppp)")).toThrow(/missing prebuilt callback stub/)
  })
})

describe("cross-sqlite-client's miniprogram adapter on the built engine", () => {
  it("migrates, de-duplicates with ON CONFLICT and reports rowsAffected", async () => {
    const { client } = await openClient()
    const first = await client.execute("INSERT INTO items (label, key) SELECT ?, ? WHERE true ON CONFLICT (key) DO NOTHING", ["a", "k"])
    const again = await client.execute("INSERT INTO items (label, key) SELECT ?, ? WHERE true ON CONFLICT (key) DO NOTHING", ["a", "k"])
    expect(first.rowsAffected).toBe(1)
    expect(again.rowsAffected).toBe(0)
  })

  it("keeps data across close() and reopening, including what a select() wrote", async () => {
    const { fs, client } = await openClient()
    await client.execute("BEGIN")
    await client.execute("INSERT INTO items (label) VALUES ('a')")
    await client.execute("COMMIT")
    await client.select("INSERT INTO items (label) VALUES ('b') RETURNING id")
    await client.close()

    const { client: reopened } = await openClient(fs)
    expect(await reopened.select<{ label: string }>("SELECT label FROM items ORDER BY id")).toEqual([{ label: "a" }, { label: "b" }])
  })

  it("supports strftime('%s','subsec') (SQLite >= 3.42, used by math-kid's schema)", async () => {
    const { client } = await openClient()
    const [row] = await client.select<{ ms: number }>("SELECT cast(strftime('%s','subsec') * 1000 as int) AS ms")
    expect(row!.ms).toBeGreaterThan(1_700_000_000_000)
  })
})
