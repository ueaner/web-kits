interface TtlDedupeEntry {
  claimedAt: number
}

type TtlDedupeState = Record<string, TtlDedupeEntry>

/**
 * A localStorage-backed, TTL-expiring "claim once" cache — e.g. to make sure a
 * cross-tab notification or tracking event fires exactly once even if several
 * tabs race to process the same id.
 */
export function createTtlDedupeCache(storageKey: string, ttlMs: number) {
  const read = (): TtlDedupeState => {
    if (typeof localStorage === "undefined") return {}
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" ? (parsed as TtlDedupeState) : {}
    } catch {
      return {}
    }
  }

  const write = (state: Map<string, TtlDedupeEntry>) => {
    if (typeof localStorage === "undefined") return
    try {
      // `Object.fromEntries` creates each property via a real data-property definition rather
      // than a `[[Set]]`/bracket assignment, so an id like "__proto__" round-trips as ordinary
      // stored data instead of silently reassigning the object's prototype (bracket assignment,
      // e.g. `obj[id] = ...`, would do exactly that for that one specific key and the "claim"
      // would vanish on write instead of persisting).
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(state)))
    } catch {
      // Storage full/unavailable — dedupe just degrades to "not guaranteed", which is safe here.
    }
  }

  const prune = (state: TtlDedupeState, now: number): Map<string, TtlDedupeEntry> => {
    const next = new Map<string, TtlDedupeEntry>()
    for (const [id, entry] of Object.entries(state)) {
      if (now - entry.claimedAt < ttlMs) {
        next.set(id, entry)
      }
    }
    return next
  }

  return {
    /** Returns true the first time `id` is claimed within the TTL window, false on any repeat. */
    claim(id: string): boolean {
      const now = Date.now()
      const state = prune(read(), now)

      // A `Map` (rather than bracket access on a plain object) means an id equal to an
      // inherited Object.prototype property name — "constructor", "toString", "__proto__" —
      // is just an ordinary key: no prototype-chain lookup, no risk of mutating the object's
      // own prototype on write.
      if (state.has(id)) {
        write(state)
        return false
      }

      state.set(id, { claimedAt: now })
      write(state)
      return true
    },
  }
}
