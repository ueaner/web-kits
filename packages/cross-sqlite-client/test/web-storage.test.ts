import { afterEach, describe, expect, it, vi } from "vitest"

// 用假的 sqlite-wasm promiser 驱动 web 适配器：只关心它最后打开了哪个文件、client.storage 报告了什么。
// opened 记下每次 open 的 filename；failOpfsOpen 让 opfs 文件的 open 失败（探测通过、打开失败的情况）
const opened: string[] = []
let failOpfsOpen = false
vi.mock("@sqlite.org/sqlite-wasm", () => {
  const promiser = async (type: string, args: { filename?: string }) => {
    if (type === "open") {
      opened.push(args.filename!)
      if (failOpfsOpen && args.filename!.includes("vfs=opfs")) throw { type: "error", result: { message: "SQLITE_CANTOPEN" } }
      return { dbId: opened.length }
    }
    return { result: { resultRows: [] } }
  }
  return { sqlite3Worker1Promiser: Object.assign(async () => promiser, { defaultConfig: undefined }), default: undefined }
})

const { createWebAdapter } = await import("../src/adapters/web")
const { DbInitializationError } = await import("../src/core/errors")

/** 模拟浏览器能力：是否跨源隔离、有没有 OPFS、OPFS 探测是否成功 */
function browser({ isolated = true, opfs = true, probeFails = false } = {}) {
  vi.stubGlobal("window", { crossOriginIsolated: isolated })
  const getFileHandle = probeFails ? vi.fn().mockRejectedValue(new Error("SecurityError")) : vi.fn().mockResolvedValue({})
  vi.stubGlobal("navigator", {
    storage: opfs ? { getDirectory: async () => ({ getFileHandle, removeEntry: async () => {} }) } : {},
  })
}

const silent = { warn: () => {}, error: () => {} }
const open = () => createWebAdapter({ singleTabLock: false, logger: silent }).initialize({ name: "app" })

afterEach(() => {
  vi.unstubAllGlobals()
  opened.length = 0
  failOpfsOpen = false
})

describe("web adapter: client.storage", () => {
  it("is persistent when the OPFS file is opened", async () => {
    browser()
    const client = await open()
    expect(opened).toEqual(["file:app.db?vfs=opfs"])
    expect(client.storage).toEqual({ persistent: true })
  })

  it("says why it fell back to memory", async () => {
    browser({ isolated: false })
    expect((await open()).storage).toEqual({ persistent: false, reason: "not-cross-origin-isolated" })
    browser({ opfs: false })
    expect((await open()).storage).toEqual({ persistent: false, reason: "opfs-unsupported" })
    browser({ probeFails: true })
    expect((await open()).storage).toEqual({ persistent: false, reason: "opfs-unavailable" })
    browser()
    failOpfsOpen = true
    expect((await open()).storage).toEqual({ persistent: false, reason: "open-failed" })
    expect(opened.at(-1)).toBe(":memory:")
  })

  it("updates after the client is closed and opened again", async () => {
    browser({ isolated: false })
    const adapter = createWebAdapter({ singleTabLock: false, logger: silent })
    const client = await adapter.initialize({ name: "app" })
    expect(client.storage.persistent).toBe(false)
    await client.close()
    browser()
    const again = await adapter.initialize({ name: "app" })
    expect(again).toBe(client)
    expect(client.storage).toEqual({ persistent: true })
  })

  it("throws instead of falling back when fallbackToMemory is false", async () => {
    browser({ isolated: false })
    const error = await createWebAdapter({ singleTabLock: false, fallbackToMemory: false, logger: silent })
      .initialize({ name: "app" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbInitializationError)
    expect(((error as Error).cause as Error).message).toMatch(/fallbackToMemory is false/)
  })
})
