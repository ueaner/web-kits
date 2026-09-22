/**
 * Single indirection over the wall clock. Cross-tab coordination can only ever compare wall
 * times (each tab has its own monotonic clock, but the localStorage they compare notes
 * through is shared), so this is `Date.now` and nothing smarter. Tests pin it with vitest's
 * fake timers, which mock `Date.now` globally — no dedicated injection hook needed.
 */
export function now(): number {
  return Date.now()
}
