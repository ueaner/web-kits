import { describe, expect, it, vi } from "vitest";
import { tryAcquireTabLock } from "../src/adapters/web";

// Web Locks API 只在 Node 24+ / 浏览器里存在；没有它的环境（Node 20/22）里
// tryAcquireTabLock 会退化为无协调的 no-op，竞争语义无从谈起，整组跳过
const hasWebLocks = typeof navigator !== "undefined" && !!navigator.locks;

describe.skipIf(!hasWebLocks)("tryAcquireTabLock", () => {
  it("acquires an uncontended lock and returns a working release() function", async () => {
    const release = await tryAcquireTabLock(`test-lock-${Math.random()}`);
    expect(release).not.toBeNull();
    release!();
  });

  it("returns null when the lock is already held, and succeeds again after release()", async () => {
    const lockName = `test-lock-${Math.random()}`;

    const first = await tryAcquireTabLock(lockName);
    expect(first).not.toBeNull();

    const second = await tryAcquireTabLock(lockName);
    expect(second).toBeNull(); // contended: first hasn't released yet

    first!();
    // 释放 Web Lock 由浏览器/Node 的锁管理器异步调度，规范不保证一个 macrotask 内完成——
    // 轮询等待而不是只等一个 tick，避免 CI 高负载下 flake
    await vi.waitFor(async () => {
      const third = await tryAcquireTabLock(lockName);
      expect(third).not.toBeNull(); // available again after release()
      third!();
    });
  });
});
