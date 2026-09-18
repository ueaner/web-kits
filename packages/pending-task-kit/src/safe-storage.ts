/**
 * Thin wrappers around `localStorage` access that degrade safely instead of throwing: reads
 * return a safe fallback, and writes/removals never throw, whether `localStorage` is
 * unavailable entirely (SSR, no `window`) or the call itself throws (quota exceeded,
 * Safari private browsing, storage disabled). `safeSetItem` reports whether the write actually
 * landed, for a caller that wants to know rather than assume — none of this package's own
 * callers currently branch on it (e.g. `poll-lease.ts`'s lease claim is deliberately fail-open
 * regardless, on the reasoning in `writeLease`'s own doc comment), but the honest signal is
 * cheap to provide now and would be easy to forget to add back later if some future caller
 * needs it.
 *
 * Shared by every localStorage-backed primitive in this package (`poll-lease`, `result-relay`,
 * `ttl-dedupe-cache`) so this failure handling lives in one place instead of being
 * re-implemented per module.
 */

export function safeGetItem(key: string): string | null {
  try {
    // The `typeof` check itself, not just the `.getItem` call after it, needs to be inside this
    // try: browsers that block storage access (cookies/site data disabled) can make the
    // `localStorage` global itself a throwing accessor, so even evaluating `typeof localStorage`
    // — which merely reads it to determine its type — can throw a SecurityError before the
    // `=== "undefined"` check ever gets to run.
    if (typeof localStorage === "undefined") return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Returns true if the write actually landed, false if it silently failed (or there's no
 *  `localStorage` to write to). */
export function safeSetItem(key: string, value: string): boolean {
  try {
    // See safeGetItem's comment on why the `typeof` check itself must be inside this try too.
    if (typeof localStorage === "undefined") return false
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeRemoveItem(key: string): void {
  try {
    // See safeGetItem's comment on why the `typeof` check itself must be inside this try too.
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(key)
  } catch {
    // Removal failing (storage disabled) leaves the stale entry in place until it's next
    // overwritten or expires on its own — the same degrade-safely tradeoff every caller here makes.
  }
}
