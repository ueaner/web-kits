import { afterEach, describe, expect, it, vi } from "vitest"
import { ASSETS_DIR, createFakeWXWebAssembly } from "./helpers/fake-miniprogram"

// initSqlite3 进程内只初始化一次：每个用例重新加载模块，拿一个新的引擎
async function freshInit() {
  vi.resetModules()
  return (await import("../dist/index.js")).initSqlite3
}

afterEach(() => vi.restoreAllMocks())

describe("initSqlite3 failures", () => {
  it("rejects instead of throwing when assetsDir is missing", async () => {
    const initSqlite3 = await freshInit()
    let result: Promise<unknown> | undefined
    expect(() => {
      result = initSqlite3({ webAssembly: createFakeWXWebAssembly() } as unknown as Parameters<typeof initSqlite3>[0])
    }).not.toThrow()
    await expect(result).rejects.toThrow(/assetsDir/)
  })

  it("rejects (and can be retried) when preparing the instance's exports throws", async () => {
    const initSqlite3 = await freshInit()
    const wx = createFakeWXWebAssembly()
    const broken = {
      ...wx,
      // 导出对象读不出来：修正导出这一步抛错。以前这个错没人接，initSqlite3 一直挂着
      instantiate: () =>
        Promise.resolve({
          instance: {
            get exports(): never {
              throw new Error("exports unavailable")
            },
          },
        }),
    }
    await expect(initSqlite3({ webAssembly: broken, assetsDir: ASSETS_DIR })).rejects.toThrow(/exports unavailable/)
    const s = await initSqlite3({ webAssembly: wx, assetsDir: ASSETS_DIR })
    expect(s.capi.sqlite3_libversion()).toMatch(/^3\./)
  })
})

describe("the glue's own warnings", () => {
  // 在 Node（和小程序）里 glue 装不上 OPFS VFS，会警告 "Ignoring inability to install 'opfs' sqlite3_vfs"
  const opfsWarning = (args: unknown[]) => args.some((arg) => typeof arg === "string" && /Ignoring inability to install/.test(arg))

  it("go to the logger, not to console.warn", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const warnings: unknown[][] = []
    const initSqlite3 = await freshInit()
    await initSqlite3({ webAssembly: createFakeWXWebAssembly(), assetsDir: ASSETS_DIR, logger: { warn: (...args) => warnings.push(args) } })
    expect(warnings.some(opfsWarning)).toBe(true)
    expect(consoleWarn.mock.calls.some(opfsWarning)).toBe(false)
    expect((globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig).toBeUndefined()
  })

  it("are dropped without a logger", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const initSqlite3 = await freshInit()
    await initSqlite3({ webAssembly: createFakeWXWebAssembly(), assetsDir: ASSETS_DIR })
    expect(consoleWarn.mock.calls.some(opfsWarning)).toBe(false)
  })
})
