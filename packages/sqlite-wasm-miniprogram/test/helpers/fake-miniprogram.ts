import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"
import { brotliDecompressSync } from "node:zlib"
import type { MiniProgramFileSystem } from "cross-sqlite-client/adapters/miniprogram"
import type { MiniProgramWebAssembly } from "../../src/shims"

/** 构建产物里的 assets/，模拟"已经复制进小程序包内的 /sqlite" */
export const ASSETS_DIR = "/sqlite"
const BUILT_ASSETS = join(import.meta.dirname, "..", "..", "dist", "assets")

function readPackageFile(path: string): Uint8Array {
  if (!path.startsWith(`${ASSETS_DIR}/`)) throw new Error(`no such file or directory "${path}"`)
  const file = join(BUILT_ASSETS, path.slice(ASSETS_DIR.length + 1))
  if (!existsSync(file)) throw new Error(`no such file or directory "${path}"`)
  const bytes = readFileSync(file)
  return path.endsWith(".br") ? brotliDecompressSync(bytes) : bytes
}

const assertPackagePath = (source: unknown) => {
  if (typeof source !== "string" || !/\.wasm(\.br)?$/.test(source)) {
    throw new Error("WXWebAssembly.Module: only support file type .wasm or .wasm.br")
  }
}

export interface FakeWXWebAssemblyOptions {
  /**
   * 模拟 iOS 真机（web-kits#10）：导出的函数是 JS 包装函数，不是 wasm 函数——length 都是 0，函数表也不收
   * （Table.set 抛 TypeError）。instantiate 和 Instance（回调桩模块）的导出都这样。
   * "zero"：length 是 0，可以重新定义；"zero-locked"：length 是 0，也不能重新定义（只能包一层）
   */
  exportLength?: "zero" | "zero-locked"
}

/**
 * 模拟 WXWebAssembly：
 * - 在另一个 realm（node:vm 的 context）里实例化，导出的函数过不了本 realm 的 instanceof Function，和开发者工具里一样；
 * - instantiate / Module 只接受包内的 .wasm / .wasm.br 路径，不接受字节；
 * - 没有 RuntimeError。
 */
export function createFakeWXWebAssembly(options: FakeWXWebAssemblyOptions = {}): MiniProgramWebAssembly & { moduleCalls: string[] } {
  const context = vm.createContext({})
  const realm = vm.runInContext("WebAssembly", context) as typeof WebAssembly
  // 另一个 realm 里的转发函数：rest 参数，length 是 0
  const forward = vm.runInContext("(f) => (...args) => f(...args)", context) as (f: Function) => Function
  const zeroLengthExports = (exports: WebAssembly.Exports): WebAssembly.Exports => {
    const out: Record<string, WebAssembly.ExportValue> = {}
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== "function") {
        out[name] = value
        continue
      }
      const fn = forward(value)
      if (options.exportLength === "zero-locked") Object.defineProperty(fn, "length", { configurable: false, writable: false })
      out[name] = fn as WebAssembly.ExportValue
    }
    return Object.freeze(out)
  }
  const moduleCalls: string[] = []
  function Module(source: unknown) {
    assertPackagePath(source)
    moduleCalls.push(source as string)
    return new realm.Module(readPackageFile(source as string) as BufferSource)
  }
  return {
    moduleCalls,
    instantiate(path: string, imports: object) {
      try {
        assertPackagePath(path)
        const result = realm.instantiate(readPackageFile(path) as BufferSource, imports as WebAssembly.Imports)
        if (!options.exportLength) return result
        return result.then(({ instance, module }) => ({ instance: { exports: zeroLengthExports(instance.exports) }, module }))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    Module,
    Instance: options.exportLength
      ? function Instance(module: WebAssembly.Module, imports: WebAssembly.Imports) {
          return { exports: zeroLengthExports(new realm.Instance(module, imports).exports) }
        }
      : realm.Instance,
    Memory: realm.Memory,
    Table: realm.Table,
  }
}

/** 内存里的小程序文件系统（回调风格，失败时给 { errMsg }） */
export function createFakeFileSystem(files = new Map<string, Uint8Array>()): MiniProgramFileSystem & { files: Map<string, Uint8Array> } {
  const dirs = new Set<string>()
  const done = <T>(cb: { success: (r: T) => void; fail: (e: { errMsg: string }) => void }, body: () => T) =>
    queueMicrotask(() => {
      try {
        cb.success(body())
      } catch (error) {
        cb.fail({ errMsg: (error as Error).message })
      }
    })
  const missing = (path: string) => new Error(`no such file or directory "${path}"`)
  return {
    files,
    mkdir: ({ dirPath, ...cb }) => done(cb, () => void dirs.add(dirPath)),
    readFile: ({ filePath, ...cb }) =>
      done(cb, () => {
        const data = files.get(filePath)
        if (!data) throw missing(filePath)
        return { data: data.slice().buffer }
      }),
    writeFile: ({ filePath, data, ...cb }) => done(cb, () => void files.set(filePath, new Uint8Array(data.slice(0)))),
    rename: ({ oldPath, newPath, ...cb }) =>
      done(cb, () => {
        const data = files.get(oldPath)
        if (!data) throw missing(oldPath)
        files.delete(oldPath)
        files.set(newPath, data)
      }),
    unlink: ({ filePath, ...cb }) =>
      done(cb, () => {
        if (!files.delete(filePath)) throw missing(filePath)
      }),
    stat: ({ path, ...cb }) =>
      done(cb, () => {
        const data = files.get(path)
        if (!data) throw missing(path)
        return { stats: { size: data.byteLength } }
      }),
  }
}
