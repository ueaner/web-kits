import { describe, expect, it } from "vitest"
import { linkAbortSignal } from "../src/kernel/abort"

describe("linkAbortSignal", () => {
  it("aborts the target when the source aborts, propagating the reason", () => {
    const source = new AbortController()
    const target = new AbortController()
    linkAbortSignal(source.signal, target)

    source.abort("custom reason")

    expect(target.signal.aborted).toBe(true)
    expect(target.signal.reason).toBe("custom reason")
  })

  it("aborts the target immediately when the source is already aborted", () => {
    const source = new AbortController()
    source.abort("already gone")
    const target = new AbortController()

    linkAbortSignal(source.signal, target)

    expect(target.signal.aborted).toBe(true)
    expect(target.signal.reason).toBe("already gone")
  })

  it("does not abort the target once unlinked", () => {
    const source = new AbortController()
    const target = new AbortController()
    const unlink = linkAbortSignal(source.signal, target)

    unlink()
    source.abort("too late")

    expect(target.signal.aborted).toBe(false)
  })

  it("unlinking after an already-aborted source is a no-op, not a throw", () => {
    const source = new AbortController()
    source.abort()
    const target = new AbortController()

    const unlink = linkAbortSignal(source.signal, target)

    expect(() => unlink()).not.toThrow()
  })
})
