import { safeRemoveItem, safeSetItem } from "./safe-storage"
import { isPendingTaskShape } from "./store"
import type { PendingTaskResultEventDetail, PendingTaskResultStatus } from "./types"

// "expired" is included for completeness against the full `PendingTaskResultStatus` union, but
// the engine never actually relays it in practice — `finalize()` returns before ever reaching
// the relay write for an "expired" outcome (expiry is silent by design, never dispatched to
// `onResult`/DOM listeners either). Accepting it here just means this parser doesn't need to
// track that engine-side detail to stay correct — it validates against the type's own shape.
const RESULT_STATUSES: readonly PendingTaskResultStatus[] = [
  "success",
  "failure",
  "error",
  "expired",
]

function isResultStatus(value: unknown): value is PendingTaskResultStatus {
  return typeof value === "string" && (RESULT_STATUSES as readonly string[]).includes(value)
}

/**
 * Only meaningful when cross-tab poll-leader election is on (see `PendingTaskPoller`'s
 * `crossTabPollLeaderElection` option): in that mode, only the elected leader tab ever calls
 * `handler.check()` and detects a task's outcome, so only it would ever locally
 * `dispatchEvent(...)` the result — every other open tab would otherwise never see it. This
 * writes the outcome to a dedicated localStorage key so every other tab's native `storage`
 * listener fires and can re-dispatch the same event on its own `window`, keeping any
 * page-level UI that listens for it working the same as if leader election were off.
 *
 * Holds only the single most recent result, not a queue — a second write before another tab's
 * listener runs still fires its own separate `storage` event (browsers dispatch one per
 * `setItem` call, not a coalesced "latest value only" notification), so no result is dropped
 * by being overwritten before it's read.
 */
export function writeResultRelay<TType extends string = string>(
  storageKey: string,
  detail: PendingTaskResultEventDetail<TType>,
): void {
  try {
    // `data` is a free-form, handler-supplied payload (type `unknown`) — JSON.stringify itself
    // (not just the localStorage write safeSetItem already guards) can throw on a circular
    // reference or a BigInt in there. Letting that escape would abort finalize() mid-dispatch,
    // taking the rest of this tick's tasks down with it — degrade the same way every other
    // localStorage-adjacent failure in this package does instead: silently skip this one relay.
    const serialized = JSON.stringify(detail)
    // Write failing means only this leader tab's own (already-dispatched) window sees the
    // result this time — other tabs miss this one relay, same degrade-safely tradeoff as
    // every other localStorage write in this package.
    safeSetItem(storageKey, serialized)
  } catch {
    // Non-serializable `data` — see the comment above.
  }
}

/** Parses a `storage` event's `newValue` for the relay key above, tolerating garbage/foreign
 *  values the same way `parseTasksFromStorageValue` does for the task list itself. */
export function parseResultRelay<TType extends string = string>(
  value: string | null,
): PendingTaskResultEventDetail<TType> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<PendingTaskResultEventDetail<TType>>
    if (!isPendingTaskShape(parsed.task) || !isResultStatus(parsed.status)) {
      return null
    }
    return parsed as PendingTaskResultEventDetail<TType>
  } catch {
    return null
  }
}

/**
 * Removes whatever result is currently sitting in the relay entry — e.g. on explicit user
 * logout, if a task's `metadata`/a handler's `data` can carry PII: the relay only ever holds
 * the single most recent result (see `writeResultRelay`), so without an explicit clear it
 * would otherwise sit there indefinitely (the next write overwrites it, but nothing proactively
 * removes it), readable by a later script or a different user on the same device.
 */
export function clearResultRelay(storageKey: string): void {
  safeRemoveItem(storageKey)
}
