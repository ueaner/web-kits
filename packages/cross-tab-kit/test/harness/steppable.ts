import { vi } from "vitest"

export interface SteppedStorage {
  /** Pauses reads of `key` at its current value: every `getItem` returns the snapshot until
   *  `unfreezeReads`, while writes still land for real. */
  freezeReads(key: string): void
  unfreezeReads(key: string): void
  restore(): void
}

/**
 * Replays the read → decide → write race window of the storage-backed primitives.
 * `claim()` is synchronous within one realm, but across real tabs the interleaving happens
 * at the storage boundary: two tabs can both read the same pre-claim state before either
 * write lands. jsdom runs everything in a single realm, so that interleaving is simulated
 * at the same boundary — freezing what a key's reads return lets tab A's claim write for
 * real while tab B's claim still decides on the pre-claim snapshot, exactly as if B's read
 * had been paused across A's write.
 */
export function createSteppableStorage(): SteppedStorage {
  const frozen = new Map<string, string | null>()
  const original = Storage.prototype.getItem
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
    if (frozen.has(key)) return frozen.get(key) ?? null
    return original.call(this, key)
  })
  return {
    freezeReads(key) {
      frozen.set(key, original.call(localStorage, key))
    },
    unfreezeReads(key) {
      frozen.delete(key)
    },
    restore() {
      spy.mockRestore()
    },
  }
}
