import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OPFS_VFS, OPFS_VFSES, createWorkerWithParams, disableVfsParams } from "../src/adapters/web-vfs"

/** 假的全局 Worker：记下构造时的 URL 和选项 */
class FakeWorker {
  static created: { url: string; options?: WorkerOptions }[] = []
  constructor(url: string | URL, options?: WorkerOptions) {
    FakeWorker.created.push({ url: String(url), options })
  }
}
/** 模拟 sqlite-wasm 的默认工厂：在调用时读全局 Worker */
const factory = () => new Worker(new URL("http://localhost/assets/sqlite3-worker1.mjs"), { type: "module" })

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.created = []
})

describe("disableVfsParams", () => {
  it("skips every OPFS VFS for an in-memory database", () => {
    expect(disableVfsParams(true)).toEqual(["opfs-disable", "opfs-wl-disable"])
  })

  it("never skips the VFS the OPFS file is opened with", () => {
    // 跳过 OPFS_VFS 自己会让 open 失败、悄悄退回内存库：孩子看到的是"进度没了"
    expect(OPFS_VFSES).toContain(OPFS_VFS)
    expect(disableVfsParams(false)).not.toContain(`${OPFS_VFS}-disable`)
    expect(disableVfsParams(false)).toEqual(["opfs-wl-disable"])
  })
})

describe("createWorkerWithParams", () => {
  it("appends the params to the URL the factory resolves, keeps its options, and puts Worker back", () => {
    vi.stubGlobal("Worker", FakeWorker)
    createWorkerWithParams(factory, ["opfs-disable", "opfs-wl-disable"])
    expect(FakeWorker.created).toEqual([
      { url: "http://localhost/assets/sqlite3-worker1.mjs?opfs-disable=&opfs-wl-disable=", options: { type: "module" } },
    ])
    expect(globalThis.Worker).toBe(FakeWorker)
  })

  it("puts Worker back when the factory throws", () => {
    vi.stubGlobal("Worker", FakeWorker)
    expect(() =>
      createWorkerWithParams(() => {
        throw new Error("factory failed")
      }, ["opfs-disable"]),
    ).toThrow("factory failed")
    expect(globalThis.Worker).toBe(FakeWorker)
  })

  it("calls the factory as is without params or without a global Worker", () => {
    vi.stubGlobal("Worker", FakeWorker)
    createWorkerWithParams(factory, [])
    expect(FakeWorker.created[0]?.url).toBe("http://localhost/assets/sqlite3-worker1.mjs")
    vi.stubGlobal("Worker", undefined)
    const worker = {} as Worker
    expect(createWorkerWithParams(() => worker, ["opfs-disable"])).toBe(worker)
  })
})

describe("OPFS_VFSES matches the installed sqlite-wasm", () => {
  it("lists exactly the OPFS VFSes its worker installs with a -disable switch", () => {
    // sqlite3-worker1.mjs 里经 opfsUtil.initOptions(name) 安装的 VFS 都读 "<name>-disable"：
    // initOptions("opfs", …)，或 const vfsName = "opfs-wl" … initOptions(vfsName, …)
    const require = createRequire(import.meta.url)
    const dist = join(dirname(require.resolve("@sqlite.org/sqlite-wasm")), "sqlite3-worker1.mjs")
    const source = readFileSync(dist, "utf8")
    expect(source).toMatch(/urlParams\.has\(vfsName \+ "-disable"\)/)
    const names = new Set<string>()
    for (const match of source.matchAll(/initOptions\("([^"]+)"/g)) names.add(match[1]!)
    for (const match of source.matchAll(/initOptions\(vfsName,/g)) {
      const before = source.slice(0, match.index)
      const declared = [...before.matchAll(/const vfsName = "([^"]+)"/g)].at(-1)
      expect(declared, 'initOptions(vfsName) 前面找不到 const vfsName = "…"').toBeDefined()
      names.add(declared![1]!)
    }
    expect([...names].sort()).toEqual([...OPFS_VFSES].sort())
  })
})
