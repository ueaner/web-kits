import { describe, expect, it, vi } from "vitest"
import { acquireTabLock } from "../src/adapters/web"

// Web Locks API 只在 Node 24+ / 浏览器里存在；没有它的环境（Node 20/22）里
// acquireTabLock 会退化为无协调的 no-op，竞争语义无从谈起，整组跳过
const hasWebLocks = typeof navigator !== "undefined" && !!navigator.locks

const uniqueName = () => `test-lock-${Math.random()}`

/** 释放 Web Lock 由锁管理器异步调度，规范不保证一个 macrotask 内完成——轮询等待，避免 CI 高负载下 flake */
async function expectAvailable(lockName: string) {
  await vi.waitFor(async () => {
    const probe = await acquireTabLock(lockName)
    expect(probe).not.toBeNull()
    probe!()
  })
}

describe.skipIf(!hasWebLocks)("acquireTabLock", () => {
  it("acquires an uncontended lock and returns a working release() function", async () => {
    const release = await acquireTabLock(uniqueName())
    expect(release).not.toBeNull()
    release!()
  })

  it("returns null when the lock is already held, and succeeds again after release()", async () => {
    const lockName = uniqueName()
    const first = await acquireTabLock(lockName)
    expect(first).not.toBeNull()
    expect(await acquireTabLock(lockName)).toBeNull()
    first!()
    await expectAvailable(lockName)
  })

  it("waits for a held lock with wait: true, and gets it once it's released", async () => {
    const lockName = uniqueName()
    const holder = await acquireTabLock(lockName)
    let settled = false
    const waiting = acquireTabLock(lockName, { wait: true }).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    holder!()
    const release = await waiting
    expect(release).not.toBeNull()
    expect(await acquireTabLock(lockName)).toBeNull() // 现在是它拿着
    release!()
  })

  it("stops waiting when the signal aborts, throwing signal.reason", async () => {
    const lockName = uniqueName()
    const holder = await acquireTabLock(lockName)
    const signal = AbortSignal.timeout(20)
    const error = await acquireTabLock(lockName, { wait: true, signal }).catch((e: unknown) => e)
    expect(signal.aborted).toBe(true)
    expect(error).toBe(signal.reason)
    holder!()
    await expectAvailable(lockName)
  })

  it("does not keep a lock that is granted at the same moment the wait is cancelled", async () => {
    const lockName = uniqueName()
    const holder = await acquireTabLock(lockName)
    const controller = new AbortController()
    const waiting = acquireTabLock(lockName, { wait: true, signal: controller.signal })
    // 放开和取消发生在同一个任务里：不管锁管理器先处理哪个，排队的这一方都不能留下锁
    holder!()
    controller.abort(new Error("cancelled"))
    await expect(waiting).rejects.toThrow("cancelled")
    await expectAvailable(lockName)
  })

  it("throws right away for an already aborted signal", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(acquireTabLock(uniqueName(), { wait: true, signal: controller.signal })).rejects.toThrow("cancelled")
  })
})
