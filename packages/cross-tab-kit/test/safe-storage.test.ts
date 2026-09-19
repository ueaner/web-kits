import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { safeGetItem, safeRemoveItem, safeSetItem } from "../src/safe-storage"

describe("safeGetItem / safeSetItem / safeRemoveItem", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("round-trips a value through localStorage", () => {
    expect(safeSetItem("k", "v")).toBe(true)
    expect(safeGetItem("k")).toBe("v")
    safeRemoveItem("k")
    expect(safeGetItem("k")).toBeNull()
  })

  it("safeGetItem returns null for a missing key", () => {
    expect(safeGetItem("missing")).toBeNull()
  })

  it("degrades safely when localStorage is undefined", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(safeGetItem("k")).toBeNull()
    expect(safeSetItem("k", "v")).toBe(false)
    expect(() => safeRemoveItem("k")).not.toThrow()
  })

  it("safeGetItem returns null when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    expect(safeGetItem("k")).toBeNull()
  })

  it("safeSetItem returns false when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    expect(safeSetItem("k", "v")).toBe(false)
  })

  it("safeRemoveItem does not throw when localStorage.removeItem throws", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    expect(() => safeRemoveItem("k")).not.toThrow()
  })
})
