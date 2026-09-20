import { assertPositiveFiniteMs, type Logger, resolveLogger } from "../kernel/logger"
import { withTabLock } from "../locks/tab-lock"
import { createPollLeaseClaimer, generatePollOwnerId, validateLeaseRecord, type PollLeaseClaimResult } from "../primitives/poll-lease"

/** How `withTabLock` reports its own `waitTimeoutMs` expiring — used to tell "we waited too
 *  long for the arbitration lock" apart from any other, unexpected rejection. */
function isArbitrationWaitTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError"
}

/** Cap on how long to wait before warning that the arbitration lock's wait might be stuck
 *  behind a wedged holder. Deliberately low even against a very long (or `Infinity`)
 *  `waitTimeoutMs`: half of "wait however long it takes" is still "however long it takes",
 *  and a stuck-holder symptom worth surfacing looks the same regardless of the eventual bound. */
const SLOW_WAIT_WARN_MS = 5_000

/**
 * One tenure of leadership handed out by `LeadershipGate.acquire`. Capture `fence` with the
 * tenure and re-check with `isStillValid()` to tell "nobody else holds the lease right now"
 * apart from "it has been mine, continuously, since I acquired" — see `PollLeaseClaimResult`
 * for the churn scenario a plain owner check can't detect.
 */
export interface Tenure {
  readonly fence: number
  /** Aborts the moment this tenure is known to be over — stolen by another tab (detected via
   *  the storage event its claim write causes), found invalid on a re-check, or released.
   *  Link it into in-flight work so losing leadership becomes real cancellation, not just
   *  after-the-fact result discarding. */
  readonly signal: AbortSignal
  /** Locked re-claim + fence comparison — and a renewal when it returns true, so re-checking
   *  also extends the tenure. False means this tenure is over; discard anything in flight —
   *  including when the arbitration lock's wait itself exceeds `waitTimeoutMs`: that's treated
   *  the same as "someone else holds the lease right now" rather than a rejection, since both
   *  mean the same thing to the caller (not confirmed as leader this check). A logger warning
   *  (see `LeadershipGateOptions.logger`) is the visibility for a wait running long, not an
   *  exception the caller has to catch. */
  isStillValid(): Promise<boolean>
}

export interface LeadershipGateOptions {
  /** Name of the Web Locks mutex claims are serialized through. Defaults to `storageKey`. */
  lockName?: string
  /** How long a claim waits for the arbitration lock before giving up on it for this call —
   *  treated the same as "someone else holds the lease" (see `LeadershipGate.acquire`).
   *  Defaults to `ttlMs` — waiting longer than the lease itself is never useful: even if the
   *  wait succeeded, the claimed lease would start out that much closer to expiry. */
  waitTimeoutMs?: number
  /** Diagnostic-warning channel: the very-short-`ttlMs` warning below, and a once-per-instance
   *  warning if a claim's wait for the arbitration lock is running long (see
   *  `LeadershipGate.acquire`) — the latter is this gate's only visibility into that case, since
   *  it resolves rather than rejects. Defaults to `console`. */
  logger?: Logger
}

/** `AbortSignal.reason` used when a tenure ends via `release()` (a deliberate shutdown),
 *  as opposed to theft or a failed re-check — lets consumers (e.g. the leadership loop)
 *  tell "shut down on purpose" apart from "lost" and stay silent for the former. */
export const TENURE_RELEASED_REASON = "cross-tab-kit:tenure-released"

export interface LeadershipGate {
  /** Claims leadership right now: resolves to a `Tenure` if this gate is the leader, or null
   *  if another tab currently holds the lease *or* the arbitration lock itself couldn't be
   *  acquired within `waitTimeoutMs` (default `ttlMs`) — both mean "not confirmed as leader
   *  this call," so both resolve null rather than one of them rejecting. A wait running past
   *  half of `waitTimeoutMs` (capped at 5s) logs a warning once per gate instance — the only
   *  visibility into a wedged holder, since this never throws for it. No timers — claiming and
   *  renewing happen only when the caller calls, so an idle caller produces zero storage
   *  traffic. */
  acquire(): Promise<Tenure | null>
  /** Synchronous, best-effort: aborts the current tenure immediately, and writes an expired
   *  tombstone (not a deletion, so the fence keeps strictly increasing) so another tab can
   *  take over without waiting out the TTL. The tombstone write is serialized through the
   *  same lock that serializes claims and lands on a later microtask — if the page dies
   *  before that (pagehide → kill), the TTL is the documented fallback. */
  release(): void
}

/**
 * Caller-paced leadership ("manual transmission"): the same TTL lease + fence machinery as
 * `createLeadershipLoop`, but with no internal timer — the caller decides when to claim
 * (e.g. inside a polling tick, just before the first network request) and when to re-check.
 * For a standing role the loop should hold (a poller, a single shared WebSocket), prefer
 * `createLeadershipLoop`; reach for the gate when claim timing must be coupled to the
 * caller's own work cycle.
 *
 * Loss detection isn't deferred to the next `isStillValid()` call: a gate also listens for
 * the `storage` event. Another tab's successful claim writes the lease key, which fires that
 * event in every *other* tab — exactly the "taken from me" case — so the current tenure's
 * `signal` aborts when the rival write lands, not when this tab next thinks to check.
 * (Frozen tabs get their events queued until they unfreeze, which is still safe.)
 */
export function createLeadershipGate(storageKey: string, ttlMs: number, options?: LeadershipGateOptions): LeadershipGate {
  // Invalid ttlMs throws here, via the claimer — a misconfiguration, surfaced at construction.
  const claimer = createPollLeaseClaimer(storageKey, ttlMs)
  const logger = resolveLogger(options?.logger)
  if (ttlMs < 1_000 && logger) {
    // Not an error, but worth one warning: a sub-second TTL means every acquire/re-check is a
    // storage write, and every write fires a storage event in every other open tab — the cost
    // scales with tab count, not with work done.
    try {
      logger.warn(
        `cross-tab-kit: createLeadershipGate's ttlMs of ${ttlMs}ms is very short — every claim and renewal is a storage write that fires a storage event in every other tab`,
      )
    } catch {
      // A diagnostic channel must never take down the code path it's diagnosing — see `Logger`.
    }
  }
  const waitTimeoutMs = options?.waitTimeoutMs ?? ttlMs
  // Same contract as withTabLock's: positive finite, or Infinity to wait without a bound.
  if (waitTimeoutMs !== Infinity) assertPositiveFiniteMs(waitTimeoutMs, "createLeadershipGate", "waitTimeoutMs")
  const ownerId = generatePollOwnerId()
  const lockName = options?.lockName ?? storageKey
  let active: { tenure: Tenure; controller: AbortController } | null = null
  let listening = false

  const abortActive = (reason?: string) => {
    const current = active
    active = null
    current?.controller.abort(reason)
  }

  const onStorage = (event: StorageEvent) => {
    if (!active) return
    // clear() fires with key === null: it wipes the lease record and resets the fence —
    // exactly the "fence must never be forgotten" scenario the tombstone exists to prevent.
    // Conservatively end this tenure; the next acquire() reclaims cleanly.
    if (event.key === null) {
      abortActive()
      return
    }
    if (event.key !== storageKey) return
    // A removal of the lease key is equivalent to a clear for this record.
    if (event.newValue === null) {
      abortActive()
      return
    }
    try {
      // Reuse claim()'s own validator (fence/expiresAt must be finite too) rather than a
      // hand-rolled, looser shape check — otherwise a malformed rival write could trip this
      // listener into a false "taken from me" that claimer.claim() itself would have ignored
      // as garbage on the very next re-check.
      const record = validateLeaseRecord(JSON.parse(event.newValue))
      // Only "the lease is now someone else's" ends this tenure; unparseable/invalid values are
      // ignored rather than trusted (a garbage record reads as unheld on the next claim anyway,
      // so nothing is lost by waiting for that).
      if (record && record.ownerId !== ownerId) {
        abortActive()
      }
    } catch {
      // Malformed event payload — ignore.
    }
  }

  const ensureListening = () => {
    if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return
    window.addEventListener("storage", onStorage)
    listening = true
  }

  let hasWarnedSlowWait = false

  const claim = (): Promise<PollLeaseClaimResult> => {
    // Scheduled fresh on every call (cleared as soon as this call settles) but only while
    // nobody's been warned yet — once the caller has seen it, repeating it every claim/renewal
    // for the gate's whole lifetime would just be noise, not new information.
    const warnAfterMs = Math.min(waitTimeoutMs / 2, SLOW_WAIT_WARN_MS)
    const warnTimer =
      logger && !hasWarnedSlowWait
        ? setTimeout(() => {
            hasWarnedSlowWait = true
            try {
              logger.warn(
                `cross-tab-kit: createLeadershipGate is still waiting for the arbitration lock after ${warnAfterMs}ms — possibly queued behind a stuck holder`,
              )
            } catch {
              // A diagnostic channel must never take down the code path it's diagnosing.
            }
          }, warnAfterMs)
        : undefined
    const clearWarnTimer = () => {
      if (warnTimer !== undefined) clearTimeout(warnTimer)
    }
    return withTabLock(lockName, () => claimer.claim(ownerId), { waitTimeoutMs }).then(
      (result) => {
        clearWarnTimer()
        return result
      },
      (error: unknown) => {
        clearWarnTimer()
        // The wait for the arbitration lock is bounded the same way "someone else holds the
        // lease" already is — both are just "not confirmed as leader this call" to every
        // caller here (acquire(), isStillValid()), so this degrades the same way instead of
        // rejecting. The warning above (not an exception) is this case's visibility.
        if (isArbitrationWaitTimeout(error)) return { leader: false as const }
        throw error
      },
    )
  }
  // Best-effort, fire-and-forget by design (see `release()` below) — shared so the same
  // tombstone-write path backs both the public `release()` and the zombie-lease cleanup in
  // `isStillValid()`.
  const releaseLease = () => withTabLock(lockName, () => claimer.release(ownerId), { waitTimeoutMs }).catch(() => undefined)

  return {
    async acquire() {
      const result = await claim()
      if (!result.leader) {
        abortActive()
        return null
      }
      // A renewal of the tenure this gate already holds returns the same tenure object —
      // same fence, same signal — so callers comparing tenures can tell "still mine" apart
      // from "a fresh tenure" by identity.
      if (active && active.tenure.fence === result.fence) return active.tenure
      abortActive()
      const controller = new AbortController()
      const tenure: Tenure = {
        fence: result.fence,
        signal: controller.signal,
        isStillValid: async () => {
          // Captured before the re-claim below can change it: telling "this is the tenure the
          // gate currently considers active" apart from "this is a stale tenure someone kept a
          // reference to after a newer `acquire()` superseded it" is exactly what distinguishes
          // the zombie-lease case from an ordinary stale re-check below.
          const wasActive = active?.tenure === tenure
          const recheck = await claim()
          const valid = recheck.leader && recheck.fence === tenure.fence
          if (!valid) {
            if (wasActive) abortActive()
            // `claim()` can't tell "renewing this tenure" apart from "this tab's own prior
            // lease had already expired and this call silently started a brand-new one" — both
            // come back `{ leader: true }`, just with a bumped fence in the second case. When
            // that lands here for the tenure the gate still considers active (`wasActive`), it
            // means this tab is now the live lease holder again, under its own ownerId, for a
            // tenure nobody asked for and isStillValid() is about to report as lost — release it
            // immediately, or this tab sits on a lease nobody's using and every other tab's
            // `acquire()` reads it as still held, waiting out a full extra `ttlMs` before anyone
            // can take over. A stale tenure re-checked after a newer `acquire()` already
            // superseded it (`!wasActive`) is a different, harmless case — `recheck` there just
            // reports the newer, legitimately active tenure, which must not be released.
            if (wasActive && recheck.leader) await releaseLease()
          }
          return valid
        },
      }
      active = { tenure, controller }
      ensureListening()
      return tenure
    },
    release() {
      abortActive(TENURE_RELEASED_REASON)
      // The tombstone write goes through the same lock that serializes claims: a bare
      // read-modify-write here can interleave with another tab's in-flight claim and
      // overwrite its fresh lease with a stale-fence tombstone (a dual-leader window and a
      // reused fence). Fire-and-forget keeps the signature synchronous; the write lands on
      // a later microtask — if the page dies before that, the TTL is the fallback.
      void releaseLease()
      if (listening) {
        window.removeEventListener("storage", onStorage)
        listening = false
      }
    },
  }
}
