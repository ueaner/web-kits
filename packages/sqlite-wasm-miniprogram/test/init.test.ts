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

describe("the glue's configuration", () => {
  const glueWarn = (s: unknown, ...args: unknown[]) => (s as { config: { warn(...a: unknown[]): void } }).config.warn(...args)
  const opfsWarning = (args: unknown[]) => args.some((arg) => typeof arg === "string" && /Ignoring inability to install/.test(arg))

  it("sends the glue's own warnings to the logger, not to console.warn", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const warnings: unknown[][] = []
    const initSqlite3 = await freshInit()
    const s = await initSqlite3({
      webAssembly: createFakeWXWebAssembly(),
      assetsDir: ASSETS_DIR,
      logger: { warn: (...args) => warnings.push(args) },
    })
    glueWarn(s, "probe")
    expect(warnings).toContainEqual(["[sqlite-wasm-miniprogram]", "probe"])
    expect(consoleWarn).not.toHaveBeenCalled()
    expect((globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig).toBeUndefined()
  })

  it("drops them without a logger", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const initSqlite3 = await freshInit()
    glueWarn(await initSqlite3({ webAssembly: createFakeWXWebAssembly(), assetsDir: ASSETS_DIR }), "probe")
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it("leaves out the JS VFSes (none works in a mini program, and their callbacks break iOS)", async () => {
    const warnings: unknown[][] = []
    const initSqlite3 = await freshInit()
    const s = await initSqlite3({
      webAssembly: createFakeWXWebAssembly(),
      assetsDir: ASSETS_DIR,
      logger: { warn: (...args) => warnings.push(args) },
    })
    // OPFS 系列整个是 JS 实现的，关掉就不注册；kvvfs 是 sqlite3.wasm 里的 C VFS，C 启动时就注册了，
    // 关掉的是 glue 给它装的 JS 方法（共 15 个回调）。它不装回调，留着无害（初始化没装回调见 ios-export-length.test.ts）
    for (const name of ["opfs", "opfs-sahpool", "opfs-wl"]) expect(s.capi.sqlite3_vfs_find(name)).toBeFalsy()
    expect(s.capi.sqlite3_vfs_find(null)).toBeTruthy()
    // 不再尝试装 OPFS，也就没有 "Ignoring inability to install 'opfs'" 这类警告
    expect(warnings.some(opfsWarning)).toBe(false)
  })
})
