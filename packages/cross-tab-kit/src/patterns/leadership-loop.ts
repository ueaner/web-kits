import { assertPositiveFiniteMs, type Logger, resolveLogger } from "../kernel/logger"
import {
  createLeadershipGate,
  TENURE_RELEASED_REASON,
  type LeadershipGate,
  type LeadershipGateOptions,
  type Tenure,
} from "./leadership-gate"

export interface LeadershipContext {
  readonly fence: number
  /** Aborts when leadership is lost — stolen (detected via the storage event the thief's
   *  claim write causes), found invalid on renewal, released on pagehide, or `stop()`ed.
   *  Link it into the work `onLeadership` starts so losing leadership cancels it. */
  readonly signal: AbortSignal
  /** Locked re-claim + fence comparison, renewing the lease on success — same semantics as
   *  `Tenure.isStillValid`. */
  isStillLeader(): Promise<boolean>
}

export interface LeadershipLoopOptions extends LeadershipGateOptions {
  /** How often to claim/renew. Defaults to `ttlMs / 3`. Must be positive, finite, and strictly
   *  less than `ttlMs` — a renewal interval at or past the TTL lets the lease lapse between
   *  renewals, so leadership flaps between tabs. See the note on background throttling below
   *  before choosing a short TTL. */
  renewIntervalMs?: number
  /** Register a `pagehide` listener that releases the lease on a graceful page exit, so the
   *  next leader doesn't wait out the TTL. Default true. Best-effort: a crash or kill fires
   *  no event, and the TTL is the fallback. */
  releaseOnExit?: boolean
  /** Called after leadership is lost — after the old context's `signal` has already aborted.
   *  Not called on `stop()` or the pagehide release: deliberate shutdowns are not losses. */
  onLeadershipLost?: () => void
  logger?: Logger
}

/**
 * Standing leadership driven by a timer — a thin driver over `createLeadershipGate`
 * (the fence comparison, abort wiring, and tombstone release all live there; this adds the
 * interval and the callback choreography):
 *
 * ```
 *        ┌──────────┐   claim 成功(新 fence)   ┌─────────┐
 *  ───▶  │ follower │ ───────────────────────▶ │ leader  │
 *        │ 定时 claim │                          │ 定时续租 │
 *        │          │ ◀─────────────────────── │         │
 *        └──────────┘   续租发现 fence 易主/被夺  └─────────┘
 * ```
 *
 * `onLeadership` fires once per new tenure — including regaining leadership after losing
 * it — never twice for the same tenure, and never after `stop()`.
 *
 * Background throttling is a design input, not an accident: Chrome intensively throttles
 * tabs hidden for over 5 minutes, aligning their timers to minute granularity. With a
 * `ttlMs` under ~3 minutes, a backgrounded leader's renewals lapse and leadership drifts to
 * a visible tab — usually exactly what you want (the work happens in the tab the user is
 * looking at). Choose `ttlMs >= 3 minutes` if leadership must survive backgrounding.
 */
export function createLeadershipLoop(
  storageKey: string,
  ttlMs: number,
  onLeadership: (ctx: LeadershipContext) => void | Promise<void>,
  options?: LeadershipLoopOptions,
): () => void {
  const logger = resolveLogger(options?.logger)
  // Invalid ttlMs throws here, via the gate's claimer — a misconfiguration, not a runtime
  // condition, so construction fails fast instead of electing no one (or everyone) silently.
  const gate: LeadershipGate = createLeadershipGate(storageKey, ttlMs, {
    lockName: options?.lockName,
    waitTimeoutMs: options?.waitTimeoutMs,
    logger: options?.logger,
  })
  if (options?.renewIntervalMs !== undefined) {
    assertPositiveFiniteMs(options.renewIntervalMs, "createLeadershipLoop", "renewIntervalMs")
    if (options.renewIntervalMs >= ttlMs) {
      throw new RangeError(
        `cross-tab-kit: createLeadershipLoop's renewIntervalMs (${options.renewIntervalMs}ms) must be less than ttlMs (${ttlMs}ms) — otherwise the lease lapses between renewals and leadership flaps between tabs`,
      )
    }
  }
  const renewIntervalMs = options?.renewIntervalMs ?? ttlMs / 3
  let stopped = false
  let ticking = false
  let current: { tenure: Tenure; ctx: LeadershipContext } | null = null

  const onTenureAborted = (tenure: Tenure) => {
    if (current?.tenure !== tenure) return
    current = null
    // Deliberate shutdowns (stop(), the pagehide release) abort with TENURE_RELEASED_REASON:
    // a shutdown is not a "loss", so onLeadershipLost stays silent for them.
    if (stopped || tenure.signal.reason === TENURE_RELEASED_REASON) return
    options?.onLeadershipLost?.()
  }

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return
    ticking = true
    try {
      const tenure = await gate.acquire()
      if (!tenure) return
      if (stopped) {
        // stop() landed while the claim was in flight — don't start leading afterwards.
        gate.release()
        return
      }
      if (current?.tenure === tenure) return
      const ctx: LeadershipContext = { fence: tenure.fence, signal: tenure.signal, isStillLeader: () => tenure.isStillValid() }
      current = { tenure, ctx }
      tenure.signal.addEventListener("abort", () => onTenureAborted(tenure), { once: true })
      // Fire-and-forget: a slow or hung `onLeadership` must not stall the renewal timer —
      // the tenure's signal is the cancellation channel, not awaiting the callback.
      void Promise.resolve()
        .then(() => onLeadership(ctx))
        .catch((error: unknown) => {
          try {
            logger?.warn(`cross-tab-kit: onLeadership callback failed: ${String(error)}`)
          } catch {
            // A diagnostic channel must never take down the code path it's diagnosing.
          }
        })
    } finally {
      ticking = false
    }
  }

  const safeTick = () => {
    void tick().catch((error: unknown) => {
      try {
        logger?.warn(`cross-tab-kit: leadership tick failed: ${String(error)}`)
      } catch {
        // A diagnostic channel must never take down the code path it's diagnosing.
      }
    })
  }

  safeTick()
  const timer = setInterval(safeTick, renewIntervalMs)

  const releaseOnExit = options?.releaseOnExit !== false
  const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function"
  const onPagehide = () => gate.release()
  if (releaseOnExit && canListen) window.addEventListener("pagehide", onPagehide)

  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (releaseOnExit && canListen) window.removeEventListener("pagehide", onPagehide)
    gate.release()
  }
}
