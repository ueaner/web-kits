import { now } from "../kernel/clock"
import { assertPositiveFiniteMs, type Logger } from "../kernel/logger"
import { createMapStorageCell } from "../kernel/storage-cell"

interface TtlDedupeEntry {
  claimedAt: number
}

export interface TtlDedupeCache {
  claim(id: string): boolean
  has(id: string): boolean
  clear(): void
}

export interface TtlDedupeCacheOptions {
  /** Reserved for future diagnostics — currently unused: construction-time misconfiguration
   *  (an invalid `ttlMs` or `maxEntries`) throws a `RangeError` rather than warning through a
   *  logger. */
  logger?: Logger
  /** Upper bound on live entries: once a `claim` would exceed it, the entries with the oldest
   *  `claimedAt` are evicted. Unbounded by default — an unbounded cache backed by storage with
   *  a full quota degrades to silently not deduping, which a bound turns into bounded
   *  forgetting instead. Must be an integer >= 1 if provided. */
  maxEntries?: number
}

/**
 * A localStorage-backed, TTL-expiring "claim once" cache — e.g. to make sure a
 * cross-tab notification or tracking event fires exactly once even if several
 * tabs race to process the same id.
 */
export function createTtlDedupeCache(storageKey: string, ttlMs: number, options?: TtlDedupeCacheOptions): TtlDedupeCache {
  assertPositiveFiniteMs(ttlMs, "createTtlDedupeCache", "ttlMs")
  // A silently-ignored invalid bound (the old behavior) is how "bounded" caches quietly grow
  // unbounded — a misconfiguration, so it throws at construction like an invalid ttlMs.
  if (options?.maxEntries !== undefined && (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)) {
    throw new RangeError(`cross-tab-kit: createTtlDedupeCache's maxEntries must be an integer >= 1, got ${options.maxEntries}`)
  }
  const maxEntries = options?.maxEntries
  const cell = createMapStorageCell<TtlDedupeEntry>(storageKey, {
    // A non-finite claimedAt is rejected too: JSON can't spell Infinity directly, but an
    // out-of-range literal like 1e999 parses to it — and an Infinity claimedAt could never
    // age out, pinning the id as "claimed" forever.
    validateEntry: (entry) => {
      const claimedAt = entry && typeof entry === "object" ? (entry as TtlDedupeEntry).claimedAt : undefined
      return typeof claimedAt === "number" && Number.isFinite(claimedAt) ? (entry as TtlDedupeEntry) : null
    },
  })

  const prune = (stored: Map<string, TtlDedupeEntry>, at: number): Map<string, TtlDedupeEntry> => {
    const next = new Map<string, TtlDedupeEntry>()
    for (const [id, entry] of stored) {
      if (at - entry.claimedAt < ttlMs) next.set(id, entry)
    }
    return next
  }

  const evictOldest = (state: Map<string, TtlDedupeEntry>) => {
    if (maxEntries === undefined) return
    while (state.size > maxEntries) {
      // Ties on claimedAt (same-millisecond claims) break in insertion order, so the just-added
      // entry — last in iteration order — is never the one evicted here.
      let oldestId: string | undefined
      let oldestAt = Infinity
      for (const [id, entry] of state) {
        if (entry.claimedAt < oldestAt) {
          oldestAt = entry.claimedAt
          oldestId = id
        }
      }
      if (oldestId === undefined) return
      state.delete(oldestId)
    }
  }

  return {
    /** Returns true the first time `id` is claimed within the TTL window, false on any repeat.
     *  The window is fixed from the first claim — a repeat does not extend it. */
    claim(id: string): boolean {
      const at = now()
      const stored = cell.read() ?? new Map<string, TtlDedupeEntry>()
      const state = prune(stored, at)

      // A `Map` (rather than bracket access on a plain object) means an id equal to an
      // inherited Object.prototype property name — "constructor", "toString", "__proto__" —
      // is just an ordinary key: no prototype-chain lookup, no risk of mutating the object's
      // own prototype on write.
      if (state.has(id)) {
        // Only write back if pruning actually dropped something — a repeat claim with nothing
        // expired changes no state, so rewriting would be a pointless localStorage write.
        if (state.size !== stored.size) {
          cell.write(state)
        }
        return false
      }

      state.set(id, { claimedAt: at })
      evictOldest(state)
      cell.write(state)
      return true
    },
    /** Side-effect-free membership check (prunes in memory, never writes) — for UI that needs
     *  to ask "did we already notify about this?" without claiming it. */
    has(id: string): boolean {
      const stored = cell.read()
      if (!stored) return false
      return prune(stored, now()).has(id)
    },
    /** Wipes every claim this cache holds — e.g. on explicit user logout, if `id`s (or
     *  whatever metadata a caller's own claim wrapper attaches alongside them) can carry PII.
     *  Unlike `claim`, this doesn't need TTL pruning first: it removes the whole entry
     *  regardless of age.
     *
     *  Best-effort, not atomic with a concurrent `claim()` in another tab: like every other
     *  primitive in this package, this is a plain, unlocked read-modify-write (`claim` reads,
     *  then this removes), so a `claim()` in another tab that read its state just before this
     *  call's removal lands can write that stale state back afterwards, resurrecting the very
     *  claim this call meant to wipe. Compose your own `withTabLock` around both calls if a
     *  logout-time clear must be atomic with respect to a claim that could race it. */
    clear(): void {
      cell.remove()
    },
  }
}
