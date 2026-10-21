import { afterEach, describe, expect, it, vi } from "vitest"
import { TextDecoder as ShimTextDecoder, TextEncoder as ShimTextEncoder, utf8Decode, utf8Encode } from "../src/shims"

// 真机上的小程序 / 小游戏没有 TextEncoder / TextDecoder，垫片要退回纯 JS 实现：拿 Node 自带的实现当参照逐字节对比
const nativeEncoder = new globalThis.TextEncoder()
const nativeDecoder = new globalThis.TextDecoder("utf-8")

const SAMPLES = [
  "",
  "abc",
  "数独设置",
  "SELECT * FROM t WHERE label = '中文' AND note = ?",
  "emoji 🎉👨‍👩‍👧 𝄞",
  "lone high \uD800 and low \uDC00 surrogates",
  "\u0000\u007f\u0080߿ࠀ￿",
  "长".repeat(20_000) + "🎉",
]

/** 固定种子的伪随机字节：覆盖截断、过长编码、代理区码点、超出范围等不合法序列 */
function randomBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

describe("pure-JS UTF-8 codec", () => {
  it.each(SAMPLES.map((s) => [s.slice(0, 24), s]))("encodes %j like the native TextEncoder", (_, text) => {
    expect(utf8Encode(text)).toEqual(nativeEncoder.encode(text))
  })

  it.each(SAMPLES.map((s) => [s.slice(0, 24), s]))("decodes %j like the native TextDecoder", (_, text) => {
    const bytes = nativeEncoder.encode(text)
    expect(utf8Decode(bytes)).toBe(nativeDecoder.decode(bytes))
  })

  it("replaces invalid byte sequences exactly like the native TextDecoder", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const bytes = randomBytes(seed, 64)
      expect(utf8Decode(bytes), `seed ${seed}`).toBe(nativeDecoder.decode(bytes))
    }
    const edge = [
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf0, 0x9f, 0x8e],
      [0xe4, 0xb8],
      [0x80],
      [0xff, 0x41],
    ]
    for (const seq of edge) expect(utf8Decode(new Uint8Array(seq)), seq.join(",")).toBe(nativeDecoder.decode(new Uint8Array(seq)))
  })
})

describe("the injected TextEncoder / TextDecoder without native ones", () => {
  afterEach(() => vi.unstubAllGlobals())
  const withoutNative = () => {
    vi.stubGlobal("TextEncoder", undefined)
    vi.stubGlobal("TextDecoder", undefined)
  }

  it("round-trips through a subarray view of a larger buffer (how the glue reads wasm memory)", () => {
    withoutNative()
    const heap = new Uint8Array(4096)
    const written = new ShimTextEncoder().encodeInto("你好，SQLite 🎉", heap.subarray(100))
    expect(new ShimTextDecoder("utf-8").decode(heap.subarray(100, 100 + written.written))).toBe("你好，SQLite 🎉")
    expect(new ShimTextDecoder().decode(heap.buffer.slice(100, 100 + written.written))).toBe("你好，SQLite 🎉")
  })

  it("refuses encodings other than UTF-8 instead of decoding them wrong", () => {
    withoutNative()
    expect(() => new ShimTextDecoder("utf-16le")).toThrow(/only utf-8/)
    expect(new ShimTextDecoder("UTF8").encoding).toBe("utf-8")
  })
})
