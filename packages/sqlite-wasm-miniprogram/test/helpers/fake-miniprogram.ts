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

/**
 * 模拟 WXWebAssembly：
 * - 在另一个 realm（node:vm 的 context）里实例化，导出的函数过不了本 realm 的 instanceof Function，和开发者工具里一样；
 * - instantiate / Module 只接受包内的 .wasm / .wasm.br 路径，不接受字节；
 * - 没有 RuntimeError。
 */
export function createFakeWXWebAssembly(): MiniProgramWebAssembly & { moduleCalls: string[] } {
  const realm = vm.runInContext("WebAssembly", vm.createContext({})) as typeof WebAssembly
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
        return realm.instantiate(readPackageFile(path) as BufferSource, imports as WebAssembly.Imports)
      } catch (error) {
        return Promise.reject(error)
      }
    },
    Module,
    Instance: realm.Instance,
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
