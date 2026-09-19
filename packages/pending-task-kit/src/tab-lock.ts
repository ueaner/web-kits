/**
 * Runs `operation` under a named Web Locks API lock (`navigator.locks`), so that
 * only one browser tab executes it at a time. Falls back to running `operation`
 * un-locked when the Web Locks API isn't available (older browsers, non-browser
 * environments, or insecure contexts).
 */
export async function withTabLock<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined

  if (!locks) {
    return operation()
  }

  return locks.request(name, async () => operation())
}
