/**
 * Aborts `target` (propagating `source`'s `reason`) once `source` aborts, or immediately if
 * `source` is already aborted. This is the wiring every signal this package hands out
 * (`TabLockContext.timeoutSignal`, `Tenure.signal`, `LeadershipContext.signal`) is meant for:
 * link it to a caller's own `AbortController` (a `fetch` call, a unit of work) so losing the
 * lock/lease becomes real cancellation instead of after-the-fact discarding.
 *
 * Call the returned function once the linked work settles — it removes the listener. Skipping
 * it leaks a listener on `source` for its whole remaining lifetime, which for a standing
 * `Tenure` reused across many calls (not a fresh one per call) can mean many calls' worth of
 * listeners accumulating on the same signal.
 */
export function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason)
    return () => undefined
  }
  const onAbort = () => target.abort(source.reason)
  source.addEventListener("abort", onAbort, { once: true })
  return () => source.removeEventListener("abort", onAbort)
}
