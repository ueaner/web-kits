import { vi } from "vitest"

export interface TabWorld {
  /** Advances the fake clock and timers — every simulated "tab" shares one wall clock,
   *  matching real tabs comparing Date.now through shared storage. */
  advance(ms: number): Promise<void>
  /** Flushes pending microtasks without advancing time. */
  flush(): Promise<void>
  /** Delivers the storage event another tab's write of `key` would have caused. Same-realm
   *  writes never fire storage events, so cross-tab notification is simulated by hand.
   *  `key === null` reproduces `localStorage.clear()`; `newValue === null` a removal. */
  fireStorageEvent(key: string | null, newValue: string | null, oldValue?: string | null): void
  /** Reads the current stored value and delivers it as another tab's fresh write. */
  fireStorageEventFromStorage(key: string): void
  cleanup(): void
}

/**
 * Multi-tab simulation for a single-realm test runner. The shared medium (localStorage) is
 * real and shared — that part needs no simulation; what separate realms would isolate is
 * faked: one fake clock drives every tab's timers (a "frozen" tab is one whose renewals
 * simply stop happening, e.g. a gate nobody calls), and storage events are dispatched
 * manually.
 *
 * What this can and cannot prove: real cross-tab races are interleavings of storage reads
 * and writes, and interleavings are exactly what this harness controls — but a single realm
 * cannot reproduce true parallel memory access, so these tests demonstrate behavior under
 * the interleavings, not the absence of others.
 */
export function createTabWorld(): TabWorld {
  vi.useFakeTimers()
  localStorage.clear()
  return {
    async advance(ms) {
      await vi.advanceTimersByTimeAsync(ms)
    },
    async flush() {
      await vi.advanceTimersByTimeAsync(0)
    },
    fireStorageEvent(key, newValue, oldValue = null) {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue, oldValue, storageArea: localStorage }))
    },
    fireStorageEventFromStorage(key) {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key), storageArea: localStorage }))
    },
    cleanup() {
      vi.useRealTimers()
      localStorage.clear()
    },
  }
}

/** Flushes pending microtasks (plus one 0ms macrotask turn) under real timers — for tests
 *  that don't run a TabWorld but still need fire-and-forget work (e.g. a gate's async
 *  tombstone write) to land. Do not use under fake timers; use `TabWorld.flush` there. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
