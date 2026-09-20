import type { Logger } from "../kernel/logger"
import { withTabLock } from "../locks/tab-lock"
import { createPollLeaseClaimer, generatePollOwnerId } from "../primitives/poll-lease"

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
   *  also extends the tenure. False means this tenure is over; discard anything in flight. */
  isStillValid(): Promise<boolean>
}

export interface LeadershipGateOptions {
  /** Name of the Web Locks mutex claims are serialized through. Defaults to `storageKey`. */
  lockName?: string
  /** Diagnostic-warning channel (invalid `ttlMs`). Defaults to `console`. */
  logger?: Logger
}

/** `AbortSignal.reason` used when a tenure ends via `release()` (a deliberate shutdown),
 *  as opposed to theft or a failed re-check — lets consumers (e.g. the leadership loop)
 *  tell "shut down on purpose" apart from "lost" and stay silent for the former. */
export const TENURE_RELEASED_REASON = "cross-tab-kit:tenure-released"

export interface LeadershipGate {
  /** Claims leadership right now: resolves to a `Tenure` if this gate is the leader, or null
   *  if another tab currently holds the lease. No timers — claiming and renewing happen only
   *  when the caller calls, so an idle caller produces zero storage traffic. */
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
  const claimer = createPollLeaseClaimer(storageKey, ttlMs, { logger: options?.logger })
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
      const parsed = JSON.parse(event.newValue) as { ownerId?: unknown } | null
      // Only "the lease is now someone else's" ends this tenure; unparseable values are
      // ignored rather than trusted (a garbage record reads as unheld on the next claim
      // anyway, so nothing is lost by waiting for that).
      if (parsed && typeof parsed === "object" && typeof parsed.ownerId === "string" && parsed.ownerId !== ownerId) {
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

  const claim = () => withTabLock(lockName, () => claimer.claim(ownerId))

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
          const recheck = await claim()
          const valid = recheck.leader && recheck.fence === tenure.fence
          if (!valid && active?.tenure === tenure) abortActive()
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
      void withTabLock(lockName, () => claimer.release(ownerId)).catch(() => undefined)
      if (listening) {
        window.removeEventListener("storage", onStorage)
        listening = false
      }
    },
  }
}
