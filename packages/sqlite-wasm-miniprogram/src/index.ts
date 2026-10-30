import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { adoptFunctions, configureShims, restoreArity, type MiniProgramWebAssembly } from "./shims"

/** sqlite3.wasm 每个导出函数的参数个数（只列参数个数不为 0 的），scripts/build.mjs 构建时读出来用 define 注入 */
declare const __SQLITE_EXPORT_ARITY__: Readonly<Record<string, number>>

export type { MiniProgramWebAssembly } from "./shims"
export type { Sqlite3Static } from "@sqlite.org/sqlite-wasm"

export interface InitSqlite3Options {
  /** 小程序的 WebAssembly 运行时：微信里传全局的 WXWebAssembly */
  webAssembly: MiniProgramWebAssembly
  /**
   * 本包 assets/ 复制到小程序包内的目录（绝对路径，如 "/sqlite"）。
   * 目录里要有 sqlite3.wasm（或 sqlite3.wasm.br）和 stubs/。
   */
  assetsDir: string
  /** 加载 brotli 压缩的 sqlite3.wasm.br（约 353 KB）还是未压缩的 sqlite3.wasm（约 879 KB），默认 "br" */
  wasmFile?: "br" | "wasm"
  /** glue 的诊断输出（例如"OPFS 装不上"这类可以忽略的警告），默认丢掉 */
  logger?: { warn(message: string, ...args: unknown[]): void }
}

/**
 * 上游类型把默认导出写成了不带参数的 init()，但运行时它接受 Emscripten 的模块参数（instantiateWasm、print……），
 * 官方文档和 glue 源码都是这样用的
 */
const initModule = sqlite3InitModule as unknown as (moduleArg: {
  instantiateWasm: (imports: object, done: (instance: unknown, module?: unknown) => void) => object
  print: (...args: unknown[]) => void
  printErr: (...args: unknown[]) => void
}) => Promise<Sqlite3Static>

/**
 * 关掉的 JS VFS：小程序里一个也用不上（kvvfs 要 localStorage / sessionStorage，OPFS 系列要 OPFS 和 Worker），
 * 而 glue 初始化时会把它们的方法当回调装进 wasm 函数表（共 27 个）。iOS 真机的 WXWebAssembly 导出的是 JS 包装函数，
 * 函数表不收（"Table.set(): Argument 1 must be null or a WebAssembly function"），装一个就初始化失败。
 * 关掉后初始化不装任何回调（SQL trace 回调构建时改成了用到才装，scripts/build.mjs）
 */
const DISABLED_VFS = { kvvfs: true, opfs: true, "opfs-vfs": true, "opfs-sahpool": true, "opfs-wl": true }

let initializing: Promise<Sqlite3Static> | null = null

function describe(error: unknown): string {
  return (error as { message?: string })?.message ?? (error as { errMsg?: string })?.errMsg ?? String(error)
}

/**
 * 初始化官方 sqlite-wasm（@sqlite.org/sqlite-wasm）在小程序里的运行环境，返回 sqlite3 对象，
 * 用法和官方的 sqlite3InitModule() 返回值一样（oo1、capi、wasm……）。
 *
 * 进程内只初始化一次，之后的调用返回同一个对象（参数以第一次为准）；失败后可以重试。
 */
export function initSqlite3(options: InitSqlite3Options): Promise<Sqlite3Static> {
  if (initializing) return initializing
  const promise = new Promise<Sqlite3Static>((resolve, reject) => {
    // 参数检查也在这里面：同步抛的错变成 rejected Promise，调用方的 .catch() 接得住
    const { webAssembly } = options
    const missing = (["instantiate", "Module", "Instance", "Memory", "Table"] as const).filter(
      (name) => typeof (webAssembly as unknown as Record<string, unknown> | undefined)?.[name] !== "function",
    )
    if (missing.length > 0) throw new Error(`[sqlite-wasm-miniprogram] webAssembly is missing ${missing.join(", ")} (pass WXWebAssembly)`)
    if (typeof options.assetsDir !== "string") throw new Error('[sqlite-wasm-miniprogram] assetsDir must be a path such as "/sqlite"')
    const assetsDir = options.assetsDir.replace(/\/+$/, "")
    const wasmPath = `${assetsDir}/sqlite3.wasm${options.wasmFile === "wasm" ? "" : ".br"}`
    configureShims({ webAssembly, stubsDir: `${assetsDir}/stubs` })
    const warn = (...args: unknown[]) => options.logger?.warn("[sqlite-wasm-miniprogram]", ...args)
    // 用 glue 认的 globalThis.sqlite3ApiConfig 配置它（glue 初始化完会删掉它）：
    // - glue 自己的警告走 sqlite3.config.warn，默认是 console.warn，不经过 printErr：接到 logger 上；
    // - 关掉 JS 实现的 VFS（DISABLED_VFS）
    const global = globalThis as { sqlite3ApiConfig?: { disable?: { vfs?: Record<string, boolean> } } & Record<string, unknown> }
    const previous = global.sqlite3ApiConfig
    global.sqlite3ApiConfig = {
      ...previous,
      warn,
      disable: { ...previous?.disable, vfs: { ...previous?.disable?.vfs, ...DISABLED_VFS } },
    }

    // instantiateWasm 钩子失败时 glue 不会自己结束，要从这里 reject
    initModule({
      instantiateWasm(imports, done) {
        webAssembly
          .instantiate(wasmPath, imports)
          .then(
            (result) => {
              const r = result as { instance?: { exports: Record<string, unknown> }; module?: unknown; exports?: Record<string, unknown> }
              // WXWebAssembly.instantiate 可能给 { instance, module }，也可能直接给 instance
              const instance = (r.instance ?? r) as { exports: Record<string, unknown> }
              // 导出对象本身是冻结的：拷一份普通对象再修正（restoreArity 可能要换成包装函数）；glue 只用 instance.exports
              const exports = restoreArity(adoptFunctions({ ...instance.exports }), __SQLITE_EXPORT_ARITY__)
              done({ exports }, r.module)
            },
            (error: unknown) => {
              throw new Error(`[sqlite-wasm-miniprogram] failed to instantiate ${wasmPath}: ${describe(error)}`, { cause: error })
            },
          )
          // 修正导出或交给 glue 时抛的错也在这里 reject，不然 initSqlite3 一直挂着、也没法重试
          .catch(reject)
        return {}
      },
      print: () => {},
      printErr: warn,
    }).then(resolve, reject)
  })
  initializing = promise
  promise.catch(() => {
    if (initializing === promise) initializing = null
  })
  return promise
}
