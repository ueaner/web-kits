// 注入 sqlite-wasm glue 的垫片：scripts/build.mjs 用 esbuild 的 inject 把 glue 里的自由变量
// URL / URLSearchParams / WebAssembly / TextEncoder / TextDecoder 换成这里的导出。小程序把每个模块包在函数里，
// 往 globalThis 上挂东西，模块里的自由变量看不到，所以只能在打包时替换。
//
// 这个文件里不要写自由变量 WebAssembly / URL / URLSearchParams / TextEncoder / TextDecoder：它自己也会被 inject 处理
// （要用原生实现时写 globalThis.TextDecoder）。

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

/** UTF-8 编码。glue 用 TextEncoder 把 SQL、绑定参数等 JS 字符串写进 wasm 内存 */
export function utf8Encode(input: string): Uint8Array {
  const out = new Uint8Array(input.length * 3)
  let n = 0
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const d = input.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      } else c = 0xfffd
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out[n++] = c
    else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6)
      out[n++] = 0x80 | (c & 63)
    } else if (c < 0x10000) {
      out[n++] = 0xe0 | (c >> 12)
      out[n++] = 0x80 | ((c >> 6) & 63)
      out[n++] = 0x80 | (c & 63)
    } else {
      out[n++] = 0xf0 | (c >> 18)
      out[n++] = 0x80 | ((c >> 12) & 63)
      out[n++] = 0x80 | ((c >> 6) & 63)
      out[n++] = 0x80 | (c & 63)
    }
  }
  return out.slice(0, n)
}

/**
 * UTF-8 解码，按 WHATWG Encoding 标准的解码算法：每段不合法的字节序列（最长的不合法前缀）换成一个 U+FFFD，
 * 和原生 TextDecoder 的结果逐字一致。glue 用它把 wasm 内存里的结果读成 JS 字符串
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = ""
  const chunk: number[] = []
  const emit = (cp: number) => {
    if (cp > 0xffff) {
      cp -= 0x10000
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023))
    } else chunk.push(cp)
    if (chunk.length >= 8192) {
      out += String.fromCharCode(...chunk)
      chunk.length = 0
    }
  }
  let needed = 0
  let seen = 0
  let cp = 0
  let lower = 0x80
  let upper = 0xbf
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (needed === 0) {
      if (b <= 0x7f) emit(b)
      else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1
        cp = b & 0x1f
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0
        if (b === 0xed) upper = 0x9f
        needed = 2
        cp = b & 0xf
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90
        if (b === 0xf4) upper = 0x8f
        needed = 3
        cp = b & 0x7
      } else emit(0xfffd)
      continue
    }
    if (b < lower || b > upper) {
      // 这段序列不完整：换成一个 U+FFFD，当前字节重新当作开头处理
      needed = seen = cp = 0
      lower = 0x80
      upper = 0xbf
      emit(0xfffd)
      i--
      continue
    }
    lower = 0x80
    upper = 0xbf
    cp = (cp << 6) | (b & 0x3f)
    if (++seen === needed) {
      emit(cp)
      needed = seen = cp = 0
    }
  }
  if (needed !== 0) emit(0xfffd)
  return out + String.fromCharCode(...chunk)
}

const toBytes = (input?: ArrayBuffer | ArrayBufferView): Uint8Array =>
  !input
    ? new Uint8Array(0)
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)

const isUtf8 = (label: string) => /^\s*(unicode-1-1-)?utf-?8\s*$/i.test(label)

/**
 * 真机上的小程序 / 小游戏没有 TextEncoder / TextDecoder（开发者工具里有，所以模拟器里看不出来）。
 * 有原生实现就用原生的，没有才用上面的纯 JS 实现；只支持 UTF-8，glue 也只用 UTF-8
 */
class ShimTextEncoder {
  readonly encoding = "utf-8"
  readonly #native = (globalThis as { TextEncoder?: new () => { encode(s: string): Uint8Array } }).TextEncoder
  #impl = this.#native ? new this.#native() : null
  encode(input = ""): Uint8Array {
    return this.#impl ? this.#impl.encode(input) : utf8Encode(input)
  }
  encodeInto(input: string, dest: Uint8Array): { read: number; written: number } {
    const bytes = this.encode(input)
    if (bytes.length > dest.length) throw new RangeError("[sqlite-wasm-miniprogram] encodeInto: destination too small")
    dest.set(bytes)
    return { read: input.length, written: bytes.length }
  }
}

class ShimTextDecoder {
  readonly encoding = "utf-8"
  #impl: { decode(input?: ArrayBufferView): string } | null
  constructor(label = "utf-8") {
    if (!isUtf8(label)) throw new RangeError(`[sqlite-wasm-miniprogram] TextDecoder: only utf-8 is supported, got "${label}"`)
    const Native = (globalThis as { TextDecoder?: new (label?: string) => { decode(input?: ArrayBufferView): string } }).TextDecoder
    this.#impl = Native ? new Native("utf-8") : null
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    const bytes = toBytes(input)
    return this.#impl ? this.#impl.decode(bytes) : utf8Decode(bytes)
  }
}

export {
  ShimWebAssembly as WebAssembly,
  ShimURL as URL,
  ShimURLSearchParams as URLSearchParams,
  ShimTextEncoder as TextEncoder,
  ShimTextDecoder as TextDecoder,
}
