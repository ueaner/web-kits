import { now } from "../kernel/clock"
import { type Logger, resolveLogger, warnOnInvalidTtl } from "../kernel/logger"
import { createStorageCell } from "../kernel/storage-cell"

export interface PollLeaseClaimerOptions {
  /** Diagnostic-warning channel for the invalid-`ttlMs` warning below. Defaults to `console`. */
  logger?: Logger
}

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
 * alongside the fact that you're leader, and pass it back into a later re-check to detect not
 * just "is nobody else holding this lease right now" but "has it been mine, continuously, since
 * I captured this fence." A plain owner-id check can't tell those apart: if this tab's lease
 * expires mid-operation, another tab claims it, fully finishes with it, and that tab's own
 * lease *also* later expires before this tab checks back in, this tab can legitimately reclaim
 * the (by then unheld) lease under its own stable owner id — succeeding a same-owner-id check
 * despite leadership having genuinely churned through someone else in between. The fence will
 * have moved on regardless, so comparing it (not just the owner id) catches this.
 */
export type PollLeaseClaimResult = { leader: true; fence: number } | { leader: false }

export interface PollLeaseClaimer {
  /**
   * Returns `{ leader: true, fence }` if `ownerId` is the leader from now until this lease's
   * TTL — either it just claimed an unheld/expired lease (a new `fence`), or it's renewing the
   * tenure it already holds (the same `fence` as last time). Returns `{ leader: false }` if a
   * different, still-unexpired owner holds the lease. Still reports success even if persisting
   * this claim silently failed — see the fail-open note in `createPollLeaseClaimer` for why
   * that's the safer failure mode than reporting the claim as lost.
   *
   * Not itself cross-tab-atomic — run this inside a `withTabLock` critical section for that
   * (`createTtlDedupeCache` is the same: a plain, unlocked "read → decide → write" primitive,
   * not locked internally on its own).
   */
  claim(ownerId: string): PollLeaseClaimResult
  /**
   * Voluntarily gives up the lease — but only if `ownerId` is the one currently holding it,
   * never another owner's. Call this on a graceful shutdown so another open tab doesn't have to
   * wait out the full TTL before taking over; an abrupt closure (crash, killed tab, or a tab
   * frozen in the browser's back/forward cache) is still handled safely by the lease simply
   * expiring on its own — that's *why* this is a renewable TTL claim rather than a held lock: a
   * frozen tab's timers stop, so it stops renewing, and any other open tab picks up leadership
   * on its next check without needing an explicit release that a frozen or killed tab could
   * never send.
   */
  release(ownerId: string): void
}

function validateLeaseRecord(parsed: unknown): PollLeaseRecord | null {
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Partial<PollLeaseRecord>
  // Non-finite numbers are rejected too: JSON can't spell NaN/Infinity, but an out-of-range
  // literal like 1e999 parses to Infinity — and an Infinity expiresAt could never lapse,
  // permanently blocking every other tab from taking over the lease.
  if (
    typeof record.ownerId !== "string" ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    typeof record.fence !== "number" ||
    !Number.isFinite(record.fence)
  ) {
    return null
  }
  return record as PollLeaseRecord
}

/**
 * Creates a renewable, localStorage-backed lease: at most one owner is considered current at a
 * time, but — unlike a held mutex — that fact expires on its own (`ttlMs` after the last
 * successful `claim`) rather than requiring an explicit release, so a leader that stops
 * renewing (closed, crashed, or frozen) can't permanently block every other tab from taking
 * over. See `PollLeaseClaimer.release` for why this matters.
 */
export function createPollLeaseClaimer(storageKey: string, ttlMs: number, options?: PollLeaseClaimerOptions): PollLeaseClaimer {
  warnOnInvalidTtl(resolveLogger(options?.logger), "createPollLeaseClaimer", ttlMs)
  const cell = createStorageCell<PollLeaseRecord>(storageKey, { validate: validateLeaseRecord })

  // A write failing (quota exceeded, private-mode Safari, storage disabled) is deliberately not
  // surfaced to the caller as a failed claim: `claim()` still reports success so this tab keeps
  // acting as leader instead of going silent forever if storage stays broken. The narrower risk —
  // this tab's own claim never lands while a different, healthy tab's *does* land, so both act
  // as leader for one tick — is self-limiting: reads (unlike writes) keep working under a
  // plain quota failure, so on this tab's very next `claim()` call it reads that other tab's now
  // real lease and correctly steps back. Only a storage outage severe enough to break reads too
  // (rare, and one where cross-tab coordination is impossible either way) leaves both tabs
  // polling independently — the same outcome as running with this feature off entirely.
  return {
    claim(ownerId) {
      const current = cell.read()
      const at = now()
      if (current && current.ownerId !== ownerId && current.expiresAt > at) {
        return { leader: false }
      }
      // A renewal (same owner, still within its own still-valid tenure) keeps the current
      // fence; anything else claiming successfully — nobody held it, it was someone else's, or
      // it was this same owner's but had already expired — starts a new one, since a gap wide
      // enough for another tab to have claimed, used, and released the lease in between can't be
      // ruled out from this read alone.
      const isRenewal = current !== null && current.ownerId === ownerId && current.expiresAt > at
      const fence = isRenewal ? current.fence : (current?.fence ?? 0) + 1
      cell.write({ ownerId, fence, expiresAt: at + ttlMs })
      return { leader: true, fence }
    },
    release(ownerId) {
      const current = cell.read()
      if (current?.ownerId === ownerId) {
        // Written back already-expired rather than removed outright: removing the record would
        // forget `fence`, so the next claim (by this owner or another) would restart it from 1
        // and could collide with a fence value some in-flight re-check is still holding onto
        // from before this release — exactly the ambiguity fencing exists to prevent. Writing
        // an expired record instead lets any tab claim immediately (same end result as removal)
        // while keeping the generation counter strictly increasing.
        cell.write({ ownerId, fence: current.fence, expiresAt: 0 })
      }
    },
  }
}

/** A per-instance random id stable for as long as the caller holds onto it — e.g. one poller
 *  instance's lifetime. Falls back to a non-cryptographic id when `crypto.randomUUID` isn't
 *  available (older browsers, non-secure contexts); this only needs to be unlikely to collide
 *  with another tab's id, not cryptographically unguessable. */
export function generatePollOwnerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${now()}-${Math.random().toString(36).slice(2)}`
}
