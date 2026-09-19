import { safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage"

interface TtlDedupeEntry {
  claimedAt: number
}

type TtlDedupeState = Record<string, TtlDedupeEntry>

export interface TtlDedupeCache {
  claim(id: string): boolean
  clear(): void
}

/**
 * A localStorage-backed, TTL-expiring "claim once" cache — e.g. to make sure a
 * cross-tab notification or tracking event fires exactly once even if several
 * tabs race to process the same id.
 */
export function createTtlDedupeCache(storageKey: string, ttlMs: number): TtlDedupeCache {
  const read = (): TtlDedupeState => {
    const raw = safeGetItem(storageKey)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" ? (parsed as TtlDedupeState) : {}
    } catch {
      return {}
    }
  }

  const write = (state: Map<string, TtlDedupeEntry>) => {
    // `Object.fromEntries` creates each property via a real data-property definition rather
    // than a `[[Set]]`/bracket assignment, so an id like "__proto__" round-trips as ordinary
    // stored data instead of silently reassigning the object's prototype (bracket assignment,
    // e.g. `obj[id] = ...`, would do exactly that for that one specific key and the "claim"
    // would vanish on write instead of persisting).
    // Storage full/unavailable — dedupe just degrades to "not guaranteed", which is safe here.
    safeSetItem(storageKey, JSON.stringify(Object.fromEntries(state)))
  }

  const prune = (state: TtlDedupeState, now: number): Map<string, TtlDedupeEntry> => {
    const next = new Map<string, TtlDedupeEntry>()
    for (const [id, entry] of Object.entries(state)) {
      // Stored state is hand-editable JSON, so an entry may be malformed (null, or a
      // non-numeric claimedAt): treat anything unparseable as already expired rather than
      // throwing or keeping it forever.
      if (entry && typeof entry.claimedAt === "number" && now - entry.claimedAt < ttlMs) {
        next.set(id, entry)
      }
    }
    return next
  }

  return {
    /** Returns true the first time `id` is claimed within the TTL window, false on any repeat.
     *  The window is fixed from the first claim — a repeat does not extend it. */
    claim(id: string): boolean {
      const now = Date.now()
      const stored = read()
      const state = prune(stored, now)

      // A `Map` (rather than bracket access on a plain object) means an id equal to an
      // inherited Object.prototype property name — "constructor", "toString", "__proto__" —
      // is just an ordinary key: no prototype-chain lookup, no risk of mutating the object's
      // own prototype on write.
      if (state.has(id)) {
        // Only write back if pruning actually dropped something — a repeat claim with nothing
        // expired changes no state, so rewriting would be a pointless localStorage write.
        if (state.size !== Object.keys(stored).length) {
          write(state)
        }
        return false
      }

      state.set(id, { claimedAt: now })
      write(state)
      return true
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
      safeRemoveItem(storageKey)
    },
  }
}
