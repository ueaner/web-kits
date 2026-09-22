import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearResultRelay, parseResultRelay, writeResultRelay } from "../src/result-relay"
import type { PendingTask, PendingTaskResultEventDetail } from "../src/types"

describe("writeResultRelay / parseResultRelay", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const task: PendingTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }

  it("round-trips a written detail through localStorage", () => {
    const detail: PendingTaskResultEventDetail = {
      task,
      status: "success",
      silent: false,
      data: { message: "done" },
    }
    writeResultRelay("relay-key", detail)
    expect(parseResultRelay(localStorage.getItem("relay-key"))).toEqual(detail)
  })

  it("round-trips every result status", () => {
    for (const status of ["success", "failure", "error", "expired"] as const) {
      const detail: PendingTaskResultEventDetail = { task, status, silent: false }
      writeResultRelay("relay-key", detail)
      expect(parseResultRelay(localStorage.getItem("relay-key"))?.status).toBe(status)
    }
  })

  it("returns null for a null value", () => {
    expect(parseResultRelay(null)).toBeNull()
  })

  it("returns null for garbage JSON", () => {
    expect(parseResultRelay("not json")).toBeNull()
  })

  it("returns null when task is missing required fields", () => {
    const value = JSON.stringify({ task: { id: "a" }, status: "success" })
    expect(parseResultRelay(value)).toBeNull()
  })

  it("returns null for an unrecognized status", () => {
    const value = JSON.stringify({ task, status: "not-a-real-status" })
    expect(parseResultRelay(value)).toBeNull()
  })

  it("defaults a missing `silent` to false — a relay written by an older version predates the field", () => {
    const value = JSON.stringify({ task, status: "success" })
    expect(parseResultRelay(value)?.silent).toBe(false)
  })

  it("only holds the most recent write, not a queue", () => {
    writeResultRelay("relay-key", { task, status: "success", silent: false })
    writeResultRelay("relay-key", { task, status: "failure", silent: false })
    expect(parseResultRelay(localStorage.getItem("relay-key"))?.status).toBe("failure")
  })

  it("does not throw when data contains a value JSON.stringify can't serialize", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const detail: PendingTaskResultEventDetail = { task, status: "success", silent: false, data: circular }

    expect(() => writeResultRelay("relay-key", detail)).not.toThrow()
    // Degrades the same way a failed localStorage write does: this one relay is skipped.
    expect(localStorage.getItem("relay-key")).toBeNull()
  })

  // safeSetItem/safeRemoveItem moved from this package's own src/safe-storage.ts to the
  // external `cross-tab-kit` dependency (see src/result-relay.ts's import) — this doesn't just
  // re-verify writeResultRelay's own try/catch around JSON.stringify (already covered above),
  // it exercises the actual degrade-safely path inside the *external* safeSetItem/
  // safeRemoveItem themselves, confirming the behavior documented in writeResultRelay's/
  // clearResultRelay's doc comments still holds now that this package no longer implements
  // that degradation itself.
  it("does not throw, and leaves nothing persisted, when the underlying localStorage.setItem throws", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      const detail: PendingTaskResultEventDetail = { task, status: "success", silent: false }
      expect(() => writeResultRelay("relay-key", detail)).not.toThrow()
      // The write never landed — a leader tab in this state is aware only of its own
      // (already-dispatched) local result; every other tab simply misses this one relay.
      expect(localStorage.getItem("relay-key")).toBeNull()
    } finally {
      setItemSpy.mockRestore()
    }
  })
})

describe("clearResultRelay", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const task: PendingTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }

  it("removes whatever result is currently stored", () => {
    writeResultRelay("relay-key", { task, status: "success", silent: false })
    expect(localStorage.getItem("relay-key")).not.toBeNull()

    clearResultRelay("relay-key")

    expect(localStorage.getItem("relay-key")).toBeNull()
  })

  it("is a no-op when nothing was ever written", () => {
    expect(() => clearResultRelay("relay-key")).not.toThrow()
  })

  it("does not throw when the underlying localStorage.removeItem throws", () => {
    writeResultRelay("relay-key", { task, status: "success", silent: false })

    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    try {
      expect(() => clearResultRelay("relay-key")).not.toThrow()
    } finally {
      removeItemSpy.mockRestore()
    }
  })
})
