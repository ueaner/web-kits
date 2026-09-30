/** Surfaces an exception thrown by consumer code (a callback, a listener) as an uncaught error
 *  on a fresh microtask — as visible as any other uncaught error in the app, but unable to abort
 *  the package's own work that invoked it. The single place this policy lives, so changing how
 *  such errors are reported means changing only this. */
export function rethrowAsync(error: unknown): void {
  queueMicrotask(() => {
    throw error
  })
}
