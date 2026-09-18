import { beforeEach, describe, expect, it } from "vitest"
import { clearResultRelay, parseResultRelay, writeResultRelay } from "../src/result-relay"
import type { PendingTask, PendingTaskResultEventDetail } from "../src/types"

describe("writeResultRelay / parseResultRelay", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const task: PendingTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }

  it("round-trips a written detail through localStorage", () => {
    const detail: PendingTaskResultEventDetail = { task, status: "success", data: { message: "done" } }
    writeResultRelay("relay-key", detail)
    expect(parseResultRelay(localStorage.getItem("relay-key"))).toEqual(detail)
  })

  it("round-trips every result status", () => {
    for (const status of ["success", "failure", "error", "expired"] as const) {
      const detail: PendingTaskResultEventDetail = { task, status }
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

  it("only holds the most recent write, not a queue", () => {
    writeResultRelay("relay-key", { task, status: "success" })
    writeResultRelay("relay-key", { task, status: "failure" })
    expect(parseResultRelay(localStorage.getItem("relay-key"))?.status).toBe("failure")
  })

  it("does not throw when data contains a value JSON.stringify can't serialize", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const detail: PendingTaskResultEventDetail = { task, status: "success", data: circular }

    expect(() => writeResultRelay("relay-key", detail)).not.toThrow()
    // Degrades the same way a failed localStorage write does: this one relay is skipped.
    expect(localStorage.getItem("relay-key")).toBeNull()
  })
})

describe("clearResultRelay", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const task: PendingTask = { id: "a", type: "demo", taskId: 1, startedAt: Date.now() }

  it("removes whatever result is currently stored", () => {
    writeResultRelay("relay-key", { task, status: "success" })
    expect(localStorage.getItem("relay-key")).not.toBeNull()

    clearResultRelay("relay-key")

    expect(localStorage.getItem("relay-key")).toBeNull()
  })

  it("is a no-op when nothing was ever written", () => {
    expect(() => clearResultRelay("relay-key")).not.toThrow()
  })
})
