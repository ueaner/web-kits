/**
 * The one place where localStorage JSON persistence lives. Both storage-backed primitives
 * (poll-lease's single record, ttl-dedupe's id→entry collection) used to hand-roll their own
 * "read JSON → validate → write back"; a cell converges that into: parse failures and
 * garbage data read as absent, validation decides what a well-formed value is, and write
 * failures (quota, private mode, disabled storage) silently degrade — every caller of this
 * package treats coordination as best-effort rather than failing the application.
 *
 * The collection form's canonical representation is a `Map`, and that is what makes the
 * prototype-pollution defense the cell's responsibility rather than each primitive's: reads
 * validate entry-by-entry into a `Map`, writes go through `Object.fromEntries` — which
 * creates each property via a real data-property definition rather than a `[[Set]]`/bracket
 * assignment, so an id like "__proto__" round-trips as ordinary stored data instead of
 * silently reassigning the object's prototype. The single-record form has no attacker-named
 * keys and uses the plain object path.
 *
 * Internal to the package — not exported from either entry point.
 */
import { safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage"

export interface StorageCell<T> {
  /** The last written value, or null when the key is absent, unparseable, or fails validation. */
  read(): T | null
  write(value: T): void
  remove(): void
}

export function createStorageCell<T>(key: string, options: { validate(parsed: unknown): T | null }): StorageCell<T> {
  return {
    read() {
      const raw = safeGetItem(key)
      if (!raw) return null
      try {
        return options.validate(JSON.parse(raw))
      } catch {
        return null
      }
    },
    write(value) {
      safeSetItem(key, JSON.stringify(value))
    },
    remove() {
      safeRemoveItem(key)
    },
  }
}

export function createMapStorageCell<V>(
  key: string,
  options: {
    /** Per-entry shape check: return the entry, or null to drop it. Malformed entries are
     *  hand-editable-JSON reality; dropping them reads them as absent rather than throwing
     *  or trusting them. */
    validateEntry(parsed: unknown): V | null
  },
): StorageCell<Map<string, V>> {
  return {
    read() {
      const raw = safeGetItem(key)
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== "object") return null
        const entries = new Map<string, V>()
        for (const [id, entry] of Object.entries(parsed)) {
          const valid = options.validateEntry(entry)
          if (valid !== null) entries.set(id, valid)
        }
        return entries
      } catch {
        return null
      }
    },
    write(value) {
      // `Object.fromEntries` — see this module's doc comment for why the write path, not each
      // caller, owns the "__proto__" defense.
      safeSetItem(key, JSON.stringify(Object.fromEntries(value)))
    },
    remove() {
      safeRemoveItem(key)
    },
  }
}
