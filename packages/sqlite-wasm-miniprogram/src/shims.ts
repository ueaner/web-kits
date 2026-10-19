// 注入 sqlite-wasm glue 的垫片：scripts/build.mjs 用 esbuild 的 inject 把 glue 里的自由变量
// URL / URLSearchParams / WebAssembly 换成这里的导出。小程序把每个模块包在函数里，往 globalThis 上
// 挂东西，模块里的自由变量看不到，所以只能在打包时替换。
//
// 这个文件里不要写自由变量 WebAssembly / URL / URLSearchParams：它自己也会被 inject 处理。

/** 小程序的 WebAssembly 运行时（WXWebAssembly）：instantiate / Module 只接受包内的 .wasm / .wasm.br 路径 */
export interface MiniProgramWebAssembly {
  instantiate(path: string, imports: object): Promise<unknown>
  Module: unknown
  Instance: unknown
  Memory: unknown
  Table: unknown
  RuntimeError?: unknown
}

interface ShimConfig {
  webAssembly: MiniProgramWebAssembly
  /** 回调桩模块在包内的目录，如 "/sqlite/stubs" */
  stubsDir: string
}

let config: ShimConfig | null = null

export function configureShims(next: ShimConfig): void {
  config = next
}

function runtime(): MiniProgramWebAssembly {
  if (!config) throw new Error("[sqlite-wasm-miniprogram] call initSqlite3() before using the engine")
  return config.webAssembly
}

/** 另一个 realm 抛出的 TypeError / RangeError 换成本 realm 的同类错误（glue 用 instanceof 判断错误类型） */
function adoptError(error: unknown): unknown {
  if (!error || typeof error !== "object" || error instanceof Error) return error
  const { name, message } = error as { name?: string; message?: string }
  if (name === "TypeError") return new TypeError(message, { cause: error })
  if (name === "RangeError") return new RangeError(message, { cause: error })
  return error
}

/** 给另一个 realm 的 Table / Memory 实例的方法套一层，只转换错误类型，返回值原样透传 */
function adoptErrors(target: object, methods: string[]): void {
  for (const method of methods) {
    const original = (target as Record<string, unknown>)[method]
    if (typeof original !== "function") continue
    Object.defineProperty(target, method, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]) {
        try {
          return (original as (...a: unknown[]) => unknown).apply(this, args)
        } catch (error) {
          throw adoptError(error)
        }
      },
    })
  }
}

/**
 * WXWebAssembly 的实例来自另一个 realm：
 * - 导出的函数过不了 glue 的 `instanceof Function` 检查：改原型就能通过，不包装，调用开销不变；
 * - 导出的函数表、内存抛的 TypeError / RangeError 过不了 glue 的 `instanceof TypeError` 检查
 *   （installFunction 先试着把 JS 函数直接放进函数表，靠 TypeError 判断要不要改走桩模块）：给 set / grow 套一层转换错误类型。
 */
export function adoptFunctions(exports: Record<string, unknown>): Record<string, unknown> {
  for (const value of Object.values(exports)) {
    if (typeof value === "function" && !(value instanceof Function)) {
      try {
        Object.setPrototypeOf(value, Function.prototype)
      } catch {
        // 改不了的就算了：glue 只检查它用到的那几个导出
      }
    } else if (value && typeof value === "object" && !(value instanceof Object)) {
      // 另一个 realm 的 WebAssembly.Table / Memory
      adoptErrors(value, ["set", "grow", "get"])
    }
  }
  return exports
}

function toHex(bytes: ArrayLike<number>): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i]! < 16 ? "0" : "") + bytes[i]!.toString(16)
  return hex
}

/**
 * glue 的 jsFuncToWasm 把 JS 回调放进 wasm 函数表时，会按签名现场拼一个小模块（new WebAssembly.Module(bytes)）。
 * 小程序只能从包内文件创建模块，所以按内容映射到构建时预先生成的 stubs/<hex>.wasm。
 */
function ShimModule(source: unknown): unknown {
  const wa = runtime() as unknown as { Module: new (source: unknown) => unknown }
  if (typeof source === "string") return new wa.Module(source)
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source as ArrayBuffer)
  const path = `${config!.stubsDir}/${toHex(bytes)}.wasm`
  try {
    return new wa.Module(path)
  } catch (error) {
    const detail = (error as { message?: string; errMsg?: string })?.message ?? (error as { errMsg?: string })?.errMsg ?? String(error)
    throw new Error(
      `[sqlite-wasm-miniprogram] missing prebuilt callback stub ${path} (a callback signature the build did not cover): ${detail}`,
    )
  }
}

function ShimInstance(module: unknown, imports: object): unknown {
  const wa = runtime() as unknown as { Instance: new (module: unknown, imports: object) => { exports: Record<string, unknown> } }
  const instance = new wa.Instance(module, imports)
  // 导出对象本身是冻结的：拷一份普通对象，顺便修正函数的原型
  return { exports: adoptFunctions({ ...instance.exports }) }
}

class ShimRuntimeError extends Error {}

/** 替换 glue 里的 WebAssembly：按需转发到 configureShims 传入的运行时 */
const ShimWebAssembly = {
  get Memory() {
    return runtime().Memory
  },
  get Table() {
    return runtime().Table
  },
  get RuntimeError() {
    return runtime().RuntimeError ?? ShimRuntimeError
  },
  Module: ShimModule,
  Instance: ShimInstance,
  instantiate(source: unknown, imports: object) {
    return runtime().instantiate(source as string, imports)
  },
}

/** glue 只用到 searchParams.get()（初始化时解析 location.href 的查询参数） */
class ShimURLSearchParams {
  get(): string | null {
    return null
  }
  has(): boolean {
    return false
  }
}

/** glue 只用到 href、pathname、searchParams（OPFS 相关的路径解析；小程序里不会真正走到） */
class ShimURL {
  readonly href: string
  readonly pathname: string
  readonly searchParams = new ShimURLSearchParams()
  constructor(url: unknown) {
    this.href = String(url)
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/[^?#]*)?/i.exec(this.href)
    this.pathname = match ? (match[1] ?? "/") : this.href
  }
  toString(): string {
    return this.href
  }
}

export { ShimWebAssembly as WebAssembly, ShimURL as URL, ShimURLSearchParams as URLSearchParams }
