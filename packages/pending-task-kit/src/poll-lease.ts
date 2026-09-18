import { safeGetItem, safeSetItem } from "./safe-storage"

interface PollLeaseRecord {
  ownerId: string
  /** Monotonically increasing generation number for this lease. Bumped on every claim that
   *  isn't a plain renewal of the same still-valid tenure (i.e. whenever the previous holder was
   *  someone else, or nobody, or this same owner's own previous claim had already expired) — see
   *  `PollLeaseClaimResult` for why callers need this, not just the owner id, to detect a lost
   *  and regained lease. */
  fence: number
  expiresAt: number
}

/**
 * The result of a `claim()` call. On success, carries the lease's current `fence` — capture it
 * alongside the fact that you're leader, and pass it back into a later `claim()` call (see
 * `PendingTaskPoller.reconfirmLeadership`) to detect not just "is nobody else holding this lease
 * right now" but "has it been mine, continuously, since I captured this fence." A plain
 * owner-id check can't tell those apart: if this tab's lease expires mid-operation, another tab
 * claims it, fully finishes with it, and that tab's own lease *also* later expires before this
 * tab checks back in, this tab can legitimately reclaim the (by then unheld) lease under its own
 * stable owner id — succeeding a same-owner-id check despite leadership having genuinely
 * churned through someone else in between. The fence will have moved on regardless, so comparing
 * it (not just the owner id) catches this.
 */
export type PollLeaseClaimResult = { leader: true; fence: number } | { leader: false }

export interface PollLeaseClaimer {
  /**
   * Returns `{ leader: true, fence }` if `ownerId` is the poll leader from now until this
   * lease's TTL — either it just claimed an unheld/expired lease (a new `fence`), or it's
   * renewing the tenure it already holds (the same `fence` as last time). Returns
   * `{ leader: false }` if a different, still-unexpired owner holds the lease. Still reports
   * success even if persisting this tab's own claim silently failed — see `writeLease`'s doc
   * comment for why that's the safer failure mode than reporting the claim as lost.
   *
   * Not itself cross-tab-atomic — the caller (see `PendingTaskPoller`) is expected to run this
   * inside a `withTabLock` critical section the way `PendingTaskPoller.claimLeadership` does.
   * (`createTtlDedupeCache` and the store's own mutators are plain, unlocked "read → decide →
   * write" primitives themselves — README-recommended `claimResultOnce` compositions wrap
   * `createTtlDedupeCache.claim` in their own `withTabLock` call for the same reason this
   * module's caller does, but neither primitive locks internally on its own.)
   */
  claim(ownerId: string): PollLeaseClaimResult
  /**
   * Voluntarily gives up the lease — but only if `ownerId` is the one currently holding it,
   * never another owner's. Call this on a graceful shutdown (e.g. `PendingTaskPoller.stop()`)
   * so another open tab doesn't have to wait out the full TTL before taking over; an abrupt
   * closure (crash, killed tab, or a tab frozen in the browser's back/forward cache) is still
   * handled safely by the lease simply expiring on its own — that's *why* this is a renewable
   * TTL claim rather than a held Web Lock: a frozen tab's timers stop, so it stops renewing,
   * and any other open tab picks up leadership on its next tick without needing an explicit
   * release that a frozen or killed tab could never send.
   */
  release(ownerId: string): void
}

function readLease(storageKey: string): PollLeaseRecord | null {
  const raw = safeGetItem(storageKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PollLeaseRecord>
    if (
      typeof parsed.ownerId !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.fence !== "number"
    ) {
      return null
    }
    return parsed as PollLeaseRecord
  } catch {
    return null
  }
}

function writeLease(storageKey: string, lease: PollLeaseRecord): void {
  // A write failing (quota exceeded, private-mode Safari, storage disabled) is deliberately not
  // surfaced to the caller as a failed claim: `claim()` still reports success so this tab keeps
  // polling instead of going silent forever if storage stays broken. The narrower risk — this
  // tab's own claim never lands while a different, healthy tab's *does* land, so both act as
  // leader for one tick — is self-limiting: `readLease` (unlike writes) keeps working under a
  // plain quota failure, so on this tab's very next `claim()` call it reads that other tab's now
  // real lease and correctly steps back. Only a storage outage severe enough to break reads too
  // (rare, and one where cross-tab coordination is impossible either way) leaves both tabs
  // polling independently — the same outcome as running with this feature off entirely.
  safeSetItem(storageKey, JSON.stringify(lease))
}

/**
 * Creates a renewable, localStorage-backed "poll leader" lease: at most one owner is
 * considered current at a time, but — unlike a held mutex — that fact expires on its own
 * (`ttlMs` after the last successful `claim`) rather than requiring an explicit release,
 * so a leader that stops renewing (closed, crashed, or frozen) can't permanently block
 * every other owner from taking over. See `PollLeaseClaimer.release` for why this matters.
 */
export function createPollLeaseClaimer(storageKey: string, ttlMs: number): PollLeaseClaimer {
  if (ttlMs <= 0 && typeof console !== "undefined") {
    // A non-positive TTL makes every claim expire before (or the instant) it's written, so
    // election silently stops electing anyone — every tab's every claim looks like a fresh,
    // unheld one, and the fence climbs on every single call instead of settling once a tab
    // holds an uncontested lease. Not fatal (best-effort election just degrades to "every tab
    // polls independently," same as turning `crossTabPollLeaderElection` off), but almost
    // certainly a misconfiguration, so it's worth flagging at the point it's easiest to notice.
    console.warn(`pending-task-kit: pollLeaseTtlMs must be positive, got ${ttlMs}`)
  }
  return {
    claim(ownerId) {
      const current = readLease(storageKey)
      const now = Date.now()
      if (current && current.ownerId !== ownerId && current.expiresAt > now) {
        return { leader: false }
      }
      // A renewal (same owner, still within its own still-valid tenure) keeps the current
      // fence; anything else claiming successfully — nobody held it, it was someone else's, or
      // it was this same owner's but had already expired — starts a new one, since a gap wide
      // enough for another tab to have claimed, used, and released the lease in between can't be
      // ruled out from this read alone.
      const isRenewal = current !== null && current.ownerId === ownerId && current.expiresAt > now
      const fence = isRenewal ? current.fence : (current?.fence ?? 0) + 1
      writeLease(storageKey, { ownerId, fence, expiresAt: now + ttlMs })
      return { leader: true, fence }
    },
    release(ownerId) {
      const current = readLease(storageKey)
      if (current?.ownerId === ownerId) {
        // Written back already-expired rather than removed outright: removing the record would
        // forget `fence`, so the next claim (by this owner or another) would restart it from 1
        // and could collide with a fence value some in-flight `reconfirmLeadership` call is still
        // holding onto from before this release — exactly the ambiguity fencing exists to
        // prevent. Writing an expired record instead lets any tab claim immediately (same
        // end result as removal) while keeping the generation counter strictly increasing.
        writeLease(storageKey, { ownerId, fence: current.fence, expiresAt: 0 })
      }
    },
  }
}

/** A per-instance random id stable for as long as the caller holds onto it — e.g. one
 *  `PendingTaskPoller` instance's lifetime. Falls back to a non-cryptographic id when
 *  `crypto.randomUUID` isn't available (older browsers, non-secure contexts); this only
 *  needs to be unlikely to collide with another tab's id, not cryptographically unguessable. */
export function generatePollOwnerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
