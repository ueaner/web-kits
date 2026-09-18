import {
  createPollLeaseClaimer,
  generatePollOwnerId,
  type PollLeaseClaimer,
  type PollLeaseClaimResult,
} from "./poll-lease"
import { parseResultRelay, writeResultRelay } from "./result-relay"
import { DEFAULT_STORAGE_KEY, DEFAULT_TTL_MS, parseTasksFromStorageValue, readPersistedTasks } from "./store"
import type { PendingTaskStore } from "./store"
import { withTabLock } from "./tab-lock"
import type {
  PendingTask,
  PendingTaskCheckResult,
  PendingTaskHandler,
  PendingTaskRegistry,
  PendingTaskResultEventDetail,
} from "./types"

export const DEFAULT_POLL_TICK_MS = 2_000
export const DEFAULT_POLL_INTERVAL_MS = 10_000
export const DEFAULT_MAX_FAILURE_COUNT = 5
export const DEFAULT_RESULT_EVENT = "pending-task-result"
/** Multiplied by the effective `pollTickMs` to get the default `pollLeaseTtlMs` — see that
 *  option's doc comment for why it needs headroom over a single tick. */
export const DEFAULT_POLL_LEASE_TTL_MULTIPLIER = 4

export interface PendingTaskPollerOptions<TType extends string = string> {
  store: PendingTaskStore<TType>
  registry: PendingTaskRegistry<TType>
  /** Called for every non-silent `success`/`failure`/`error` outcome. This is where apps show a toast, navigate, or invalidate a cache — the engine has no opinion on any of that. */
  onResult?: (detail: PendingTaskResultEventDetail<TType>) => void
  /**
   * Called whenever `handler.check` throws, before the normal failure-count/backoff/expiry
   * handling runs. The engine has no notion of auth, tokens, or sessions — if `check()` can
   * fail for a reason that shouldn't count as a normal transient error (e.g. the caller's own
   * session just ended), inspect `error` here and return `true` to skip the normal failure
   * counting and stop the *current* tick early (the task is left as-is, `lastCheckedAt` is
   * still bumped so it isn't treated as overdue again immediately). Return `false`/`undefined`
   * (or omit this option) to fall through to the standard failure-count/backoff/expiry path.
   */
  onCheckError?: (error: unknown, task: PendingTask<TType>) => boolean | void
  /**
   * Optional cross-tab "claim once" gate around the final `onResult`/DOM-event dispatch
   * (task removal from the store always happens regardless). Compose `withTabLock` +
   * `createTtlDedupeCache` here to prevent duplicate toasts when multiple tabs race to
   * process the same completed task. This guards `onResult`/the toast-equivalent side effect
   * specifically — it's orthogonal to `crossTabPollLeaderElection`, which is about not
   * duplicating the *polling* itself; keep both if you want both properties.
   *
   * If your own implementation layers in something time-sensitive of its own — e.g. only
   * proceeding while a session is still valid — check that condition *after* your `withTabLock`
   * call resolves, not only before it: `withTabLock` is a genuine async yield (real cross-tab
   * lock arbitration), so state can legitimately change while it's pending. A check placed only
   * before it can pass, then have the underlying condition change during the wait, and the
   * claimed/dispatched side effect would still fire against the now-stale state. (`finalize()`
   * itself calls this once and acts on the result immediately after, with no further `await` in
   * between — the same "recheck right before acting" discipline applies to whatever you put
   * inside this callback.)
   *
   * On the leader tab specifically, returning `false` here also suppresses the cross-tab result
   * relay (see `resultRelayKey`) for this result — not just this tab's own `onResult`/DOM event.
   * That's the right call for the dedup use case above (another tab already claimed it, so that
   * other tab is the one that will relay). If you layer in a veto unrelated to dedup (the
   * session-validity check above, evaluated on the *leader's* state), a `false` there means
   * *every* open tab loses this result, including ones whose own session is still fine — for a
   * receiving-side-only veto that only affects the tab evaluating it, use `acceptRelayedResult`
   * instead (or alongside this).
   */
  claimResultOnce?: (task: PendingTask<TType>) => Promise<boolean> | boolean
  /** How often the engine re-scans the task list. Individual tasks still respect their own poll interval. */
  pollTickMs?: number
  /** Fallback per-check interval (ms) for handlers that don't set `pollIntervalMs`. */
  defaultPollIntervalMs?: number
  /** Fallback TTL (ms) for tasks whose handler doesn't set `ttlMs`. */
  defaultTtlMs?: number
  maxFailureCount?: number
  /** Also `window.dispatchEvent(new CustomEvent(eventName, { detail }))` for cross-component listening. Defaults to true when `window` exists. */
  dispatchDomEvent?: boolean
  eventName?: string
  /** localStorage key the store persists to — must match what `createPendingTaskStore` was given. */
  storageKey?: string
  /**
   * When multiple browser tabs share the same store (the normal case — the store already
   * syncs across tabs via `storage` events), only one of them actually calls `handler.check()`
   * for a given task at a time; the others skip their own network work entirely for tasks
   * that tab isn't the elected leader for, and instead learn the outcome via the (also
   * newly-enabled) result relay once the leader dispatches it — see `resultRelayKey`.
   *
   * Defaults to `true`. Safe to leave on for single-tab usage: an uncontested instance always
   * successfully claims/renews its own lease, so this changes nothing when there's no
   * contention. Turn it off only if you specifically don't want that (e.g. you're not running
   * in an environment with shared `localStorage` across the "tabs" this is designed for, or
   * you're intentionally running independent pollers that must each poll everything).
   */
  crossTabPollLeaderElection?: boolean
  /** localStorage key (and Web Lock name) backing the poll-leader lease. Defaults to
   *  `` `${storageKey}-poll-leader` ``. Only relevant when `crossTabPollLeaderElection` is on. */
  pollLeaseKey?: string
  /**
   * How long a claimed poll-leader lease stays valid without renewal before another tab may
   * claim it. Defaults to `pollTickMs * 4` — comfortably longer than one normal tick, so a
   * live leader always renews well before expiry, but short enough that a leader that stops
   * renewing (closed, crashed, or frozen in the browser's back/forward cache) only blocks
   * takeover for a bounded, short window rather than indefinitely.
   *
   * Note this bounds *renewal cadence*, not any single `handler.check()` call's own duration:
   * a single slow request can still outlast this TTL, which is exactly why the engine
   * re-confirms leadership again right after `check()` resolves/throws, before acting on a
   * possibly-stale outcome — see the source of `runTick` if you're curious about the mechanism.
   * Raising this value doesn't need to account for that case; it only trades off how long a
   * genuinely dead leader blocks takeover.
   */
  pollLeaseTtlMs?: number
  /** localStorage key used to relay a completed task's result to other tabs when
   *  `crossTabPollLeaderElection` is on (only the leader tab detects completion, so without
   *  this, every other tab's `dispatchDomEvent` listeners would never fire). Defaults to
   *  `` `${storageKey}-result-relay` ``. */
  resultRelayKey?: string
  /**
   * Optional gate on the *receiving* side of the cross-tab result relay (only relevant when
   * `crossTabPollLeaderElection` is on): called right before this tab re-dispatches a result
   * that arrived via another tab's `storage` write, letting this tab veto it. Return `false`
   * to skip the dispatch entirely. Omit it (the default) to always accept, matching the
   * engine's behavior before this option existed.
   *
   * The engine has no notion of sessions — if a relayed result could belong to a session that
   * has since ended in *this* tab (a different account signed in, a logout), and re-surfacing
   * it to this tab's own listeners would be wrong (the task's `metadata`/`data` can carry
   * PII), inspect `detail` here and check whatever your app considers "still valid" — the same
   * way `claimResultOnce` lets you gate the leader's own outgoing dispatch. This is the
   * receiving-side half of that same concern; without it, there was previously no way to
   * intercept an inbound relayed result at all.
   *
   * Evaluated synchronously with no `await` before the dispatch it gates (unlike
   * `claimResultOnce`, there's no cross-tab claim to arbitrate on this side — only this tab
   * decides whether to act on what it received, so there's no lock-arbitration window for
   * your condition to go stale in between). If your own check is inherently async (e.g. reads
   * from IndexedDB), resolve it eagerly elsewhere and read a synchronous flag here rather than
   * awaiting inline.
   */
  acceptRelayedResult?: (detail: PendingTaskResultEventDetail<TType>) => boolean
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "Unknown error"
}

/**
 * Framework-agnostic polling engine: scans the store's tasks on an interval, calls the
 * matching handler's `check()`, and resolves each task to `pending` (re-check later),
 * `success`/`failure` (dispatched via `onResult`, then removed), silently-or-not `error`
 * (removed; dispatched unless `silentOnFailure`) when `check()` itself kept failing, or
 * silently expired (removed, never dispatched — unless the handler opts into
 * `finalCheckOnExpiry` for one last check).
 *
 * When multiple tabs share a store, `crossTabPollLeaderElection` (on by default) ensures only
 * one of them actually polls at a time — see that option and `resultRelayKey` for how the
 * others still learn about results without polling themselves.
 *
 * Framework bindings (see `./react`) are thin wrappers that call `start()`/`stop()` at the
 * right lifecycle moments and expose `forceCheckAll()` for e.g. tab-focus recovery.
 *
 * Note: `stop()` prevents any *new* tick from starting, but a tick already awaiting
 * `handler.check()` when `stop()` is called will still run to completion (there is no
 * `AbortSignal` plumbed into the handler contract). Design handlers to be safe to finish
 * even if the caller has logically "stopped" — e.g. don't assume side effects are undone.
 */
export class PendingTaskPoller<TType extends string = string> {
  private readonly options: Required<
    Omit<
      PendingTaskPollerOptions<TType>,
      "onResult" | "onCheckError" | "claimResultOnce" | "acceptRelayedResult"
    >
  > &
    Pick<
      PendingTaskPollerOptions<TType>,
      "onResult" | "onCheckError" | "claimResultOnce" | "acceptRelayedResult"
    >

  /** Stable for this instance's whole lifetime — e.g. one `PendingTaskPoller` construction per
   *  browser tab (that's how the React binding uses it). Regenerating this per claim would make
   *  a tab unable to recognize its own still-valid lease as "mine" on the next renewal. */
  private readonly ownerId: string
  private readonly pollLease: PollLeaseClaimer

  private intervalId: ReturnType<typeof setInterval> | undefined
  private storageListener: ((event: StorageEvent) => void) | undefined
  private isChecking = false
  private pendingForce = false
  private stopped = false
  private latestTasksCache: { tasks: PendingTask<TType>[]; byId: Map<string, PendingTask<TType>> } | undefined
  /** Task ids that already got their one `finalCheckOnExpiry` attempt, so a repeatedly-failing
   *  final check doesn't get retried every tick. Reset on process restart — worst case that
   *  costs one extra check, never an infinite retry loop.
   *
   *  Every id added here (only when a task is expired, right before its final `check()`) is
   *  removed again before the *same* tick's iteration moves past that task — either by
   *  `finalize()`'s first line, or by one of the leadership-loss/`onCheckError`-intercept
   *  branches that bail out without ever reaching `finalize()`. Nothing here is meant to
   *  survive past the tick that added it. */
  private readonly finalCheckAttempted = new Set<string>()

  constructor(options: PendingTaskPollerOptions<TType>) {
    const storageKey = options.storageKey ?? options.store.storageKey ?? DEFAULT_STORAGE_KEY
    const pollTickMs = options.pollTickMs ?? DEFAULT_POLL_TICK_MS

    this.options = {
      store: options.store,
      registry: options.registry,
      pollTickMs,
      defaultPollIntervalMs: options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      defaultTtlMs: options.defaultTtlMs ?? DEFAULT_TTL_MS,
      maxFailureCount: options.maxFailureCount ?? DEFAULT_MAX_FAILURE_COUNT,
      dispatchDomEvent: options.dispatchDomEvent ?? typeof window !== "undefined",
      eventName: options.eventName ?? DEFAULT_RESULT_EVENT,
      storageKey,
      crossTabPollLeaderElection: options.crossTabPollLeaderElection ?? true,
      pollLeaseKey: options.pollLeaseKey ?? `${storageKey}-poll-leader`,
      pollLeaseTtlMs: options.pollLeaseTtlMs ?? pollTickMs * DEFAULT_POLL_LEASE_TTL_MULTIPLIER,
      resultRelayKey: options.resultRelayKey ?? `${storageKey}-result-relay`,
      onResult: options.onResult,
      onCheckError: options.onCheckError,
      claimResultOnce: options.claimResultOnce,
      acceptRelayedResult: options.acceptRelayedResult,
    }
    this.ownerId = generatePollOwnerId()
    this.pollLease = createPollLeaseClaimer(this.options.pollLeaseKey, this.options.pollLeaseTtlMs)
  }

  start(): void {
    this.stopped = false
    if (this.intervalId !== undefined) return

    this.intervalId = setInterval(() => {
      this.runTickSafely(false)
    }, this.options.pollTickMs)

    if (typeof window !== "undefined") {
      this.storageListener = (event: StorageEvent) => {
        if (event.key === null) {
          // localStorage.clear() fires with key: null — treat it as this store being wiped too.
          this.options.store.writeTasks([])
          return
        }
        if (event.key === this.options.storageKey) {
          // Goes through the store's own `writeTasks` (not `setState` directly) so a throwing
          // re-write here (this tab's own quota/private-mode issue racing another tab's write)
          // updates the same shared `hasUnpersistedWrites` fact this store's mutators and
          // `flushBatch` read, instead of escaping this handler uncaught.
          this.options.store.writeTasks(parseTasksFromStorageValue<TType>(event.newValue))
          return
        }
        if (this.options.crossTabPollLeaderElection && event.key === this.options.resultRelayKey) {
          const detail = parseResultRelay<TType>(event.newValue)
          if (!detail) return
          let accepted: boolean
          try {
            accepted = this.options.acceptRelayedResult?.(detail) ?? true
          } catch (error) {
            // A throwing acceptRelayedResult is a consumer bug, same category as an onResult
            // throw below — surface it consistently (queued, not left to escape this raw
            // "storage" event listener callback directly) rather than letting its behavior
            // differ from the queueMicrotask treatment onCheckError/onResult get elsewhere.
            queueMicrotask(() => {
              throw error
            })
            return
          }
          if (accepted) void this.dispatchRelayedResult(detail)
        }
      }
      window.addEventListener("storage", this.storageListener)
    }

    this.runTickSafely(false)
  }

  stop(): void {
    this.stopped = true
    this.pendingForce = false

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    if (this.storageListener && typeof window !== "undefined") {
      window.removeEventListener("storage", this.storageListener)
      this.storageListener = undefined
    }
    if (this.options.crossTabPollLeaderElection) {
      // Best-effort and not awaited — stop() is a synchronous API. If this never lands (page
      // unloading right now, storage disabled), the lease just expires on its own TTL instead
      // of being released early; see PollLeaseClaimer.release's doc comment for why that's
      // still safe rather than blocking every other tab.
      void this.releaseLeadership().catch(() => undefined)
    }
  }

  /** Re-check every tracked task right now, bypassing each task's poll interval (e.g. on tab focus). */
  forceCheckAll(): void {
    this.runTickSafely(true)
  }

  private claimLeadership(): Promise<PollLeaseClaimResult> {
    return withTabLock(this.options.pollLeaseKey, () => this.pollLease.claim(this.ownerId))
  }

  /**
   * Re-confirms that poll leadership is still this tab's — and still the *same continuous
   * tenure* as when `fence` was captured, not just "is nobody else currently holding it" (a
   * no-op returning `fence` unchanged when `crossTabPollLeaderElection` is off). Clears `task`'s
   * `finalCheckAttempted` bookkeeping and returns `false` if not — the caller should stop
   * treating this tick's remaining due tasks as network-eligible (though it may still process
   * ones that need no leadership) rather than act on a possibly-stale outcome.
   *
   * A fence mismatch (rather than just an owner-id mismatch) is needed to catch leadership
   * having churned through another tab and back to this one while a slow `handler.check()` was
   * in flight: this tab's lease can expire mid-check, another tab claims it and fully resolves
   * the same task, and that tab's own lease can *also* expire before this tab's stale response
   * comes back — at which point this tab's next claim legitimately succeeds under its own
   * stable owner id (nothing currently holds the lease), even though leadership genuinely
   * changed hands in between. See `PollLeaseClaimResult`.
   */
  private async reconfirmLeadership(
    task: PendingTask<TType>,
    expired: boolean,
    fence: number | undefined,
  ): Promise<number | undefined | false> {
    if (!this.options.crossTabPollLeaderElection) return fence
    if (this.stopped) {
      // stop() has already (best-effort) released this tab's own lease so another tab doesn't
      // have to wait out the full TTL — reclaiming it here, even just to immediately discard a
      // stale response, would write a brand-new full-TTL lease that nothing will ever renew
      // (this poller is stopped), undoing exactly that. Treat "stopped" the same as "leadership
      // lost" without ever attempting to reclaim.
      if (expired) this.finalCheckAttempted.delete(task.id)
      return false
    }
    let result: PollLeaseClaimResult
    try {
      result = await this.claimLeadership()
    } catch (error) {
      // A rejected claim (e.g. `navigator.locks.request` itself throwing) must not leave this
      // task's finalCheckAttempted entry dangling past this tick — surface the error the same
      // way as before, just without leaking that bookkeeping first.
      if (expired) this.finalCheckAttempted.delete(task.id)
      throw error
    }
    if (result.leader && result.fence === fence) return result.fence
    if (expired) this.finalCheckAttempted.delete(task.id)
    return false
  }

  private releaseLeadership(): Promise<void> {
    return withTabLock(this.options.pollLeaseKey, () => {
      this.pollLease.release(this.ownerId)
    })
  }

  /** Fires `runTick`, but instead of leaving its promise `void`-called (which would turn an
   *  exception thrown by a consumer callback — `onResult`, `onCheckError`, or a `dispatchEvent`
   *  listener — into a silent unhandled rejection), re-throws it as an uncaught exception on a
   *  fresh microtask. `runTick`'s own `finally` has already flushed the batch and reset
   *  `isChecking` by the time this ever runs, so a broken consumer callback can't take the
   *  poller down — it just becomes visible the way any other uncaught error in the host
   *  environment would be, instead of vanishing. */
  private runTickSafely(force: boolean): void {
    this.runTick(force).catch((error: unknown) => {
      queueMicrotask(() => {
        throw error
      })
    })
  }

  /** Reads the freshest snapshot of `task` from the store, in case another tab wrote to it
   *  while this tab's `handler.check()` was in flight — narrows, but doesn't eliminate, the
   *  window where a concurrent cross-tab write to the same task could be clobbered.
   *
   *  Indexes `store.getState().tasks` into a Map keyed by id rather than doing a linear find
   *  each call — this is called once per pending/failing task per tick, so a plain find would
   *  make a tick O(n²). The cache keys off the `tasks` array reference, which zustand only
   *  replaces on an actual write, so it's rebuilt only when the store has genuinely changed. */
  private getLatestTask(task: PendingTask<TType>): PendingTask<TType> {
    const tasks = this.options.store.getState().tasks
    if (this.latestTasksCache?.tasks !== tasks) {
      this.latestTasksCache = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) }
    }
    return this.latestTasksCache.byId.get(task.id) ?? task
  }

  /** Applies a whole tick's worth of per-task updates/removals (`patch: null` means "remove")
   *  in a single read-modify-write, instead of one persisted-storage round trip per task.
   *  Reads the freshest persisted list right before writing (same "never resurrect a task
   *  another tab already removed" guarantee `PendingTaskStore`'s own mutators give) — unless
   *  the store's `hasUnpersistedWrites` is set (a write on *any* path for this store, including
   *  this store's own direct mutators, failed and hasn't yet been followed by a success), in
   *  which case persisted storage is stale relative to this tab's memory, so this flush builds
   *  on `store.getState().tasks` instead. Writes through `writeTasks`, which swallows a
   *  throwing write and updates that same shared flag — see the comment in `store.ts`. */
  private flushBatch(batch: Map<string, Partial<PendingTask<TType>> | null>): void {
    if (batch.size === 0) return

    const base = this.options.store.hasUnpersistedWrites
      ? this.options.store.getState().tasks
      : readPersistedTasks<TType>(this.options.storageKey)

    const next: PendingTask<TType>[] = []
    for (const t of base) {
      if (!batch.has(t.id)) {
        next.push(t)
        continue
      }
      const patch = batch.get(t.id)
      if (patch !== null) next.push({ ...t, ...patch })
    }

    this.options.store.writeTasks(next)
  }

  private async finalize(
    task: PendingTask<TType>,
    detail: Omit<PendingTaskResultEventDetail<TType>, "task">,
    handler: PendingTaskHandler<TType> | undefined,
    batch: Map<string, Partial<PendingTask<TType>> | null>,
  ): Promise<void> {
    this.finalCheckAttempted.delete(task.id)
    batch.set(task.id, null)

    if (detail.status === "expired") return

    const silent = detail.status === "success" ? handler?.silentOnSuccess : handler?.silentOnFailure
    if (silent) return

    let claimed: boolean
    try {
      claimed = this.options.claimResultOnce ? await this.options.claimResultOnce(task) : true
    } catch {
      // claimResultOnce is documented as a cross-tab "claim once" gate that can reasonably
      // reject (e.g. a lock timeout) — treat that the same as "another tab already claimed it"
      // and skip the dispatch. The removal above already happened, so nothing is left to retry.
      // Unlike this, an exception from `onResult`/`dispatchEvent` below is a real consumer bug
      // and is deliberately left uncaught — `runTickSafely` surfaces it instead of hiding it.
      return
    }
    if (!claimed) return

    const fullDetail: PendingTaskResultEventDetail<TType> = { task, ...detail }
    if (this.options.crossTabPollLeaderElection) {
      // Written before onResult/dispatchDomEvent below, deliberately: this relay data is
      // independent of either local callback, and both onResult and a dispatchEvent listener
      // are consumer code that's allowed to throw (surfaced, not swallowed — see the doc
      // comment on runTickSafely). If the relay write came after them, a throwing onResult in
      // just the leader tab would silently strand every *other* tab, which would never learn
      // this result at all (see dispatchRelayedResult) — a single consumer bug in one tab
      // shouldn't be able to take every other open tab down with it.
      writeResultRelay(this.options.resultRelayKey, fullDetail)
    }
    this.options.onResult?.(fullDetail)
    if (this.options.dispatchDomEvent && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(this.options.eventName, { detail: fullDetail }))
    }
  }

  /**
   * Handles a result relayed from another tab's leader — mirrors finalize()'s own
   * `claimResultOnce` gate and dispatch, so a `claimResultOnce` composed for "one notification
   * system-wide" (see its doc comment's "keep both if you want both properties") applies
   * uniformly whether this tab detected the result itself or only learned about it via the
   * relay, not just to the narrower direct-detection race `claimResultOnce` guarded before this
   * relay existed.
   *
   * Fired-and-forgotten (`void`-called) from the "storage" listener rather than awaited, so it
   * has no `this.stopped` check of its own: `stop()` removes the listener (no *new* relayed
   * result starts one of these after that), but one already in flight when `stop()` is called
   * (e.g. awaiting a slow `claimResultOnce`) still runs to completion — the same tolerance
   * `runTick`'s own doc comment describes for an in-flight tick.
   */
  private async dispatchRelayedResult(detail: PendingTaskResultEventDetail<TType>): Promise<void> {
    let claimed: boolean
    try {
      claimed = this.options.claimResultOnce ? await this.options.claimResultOnce(detail.task) : true
    } catch {
      // Same treatment as finalize()'s own claimResultOnce catch: a reasonable rejection (e.g. a
      // lock timeout) is treated as "already claimed elsewhere," not a bug.
      return
    }
    if (!claimed) return

    try {
      this.options.onResult?.(detail)
      if (this.options.dispatchDomEvent && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(this.options.eventName, { detail }))
      }
    } catch (error) {
      // An onResult/dispatchEvent throw here is a real consumer bug, same category as the one
      // finalize() deliberately leaves uncaught — but unlike finalize() (called from runTick,
      // which flows into runTickSafely's own catch-and-requeue), this method is invoked directly
      // from a raw "storage" event listener with no equivalent wrapper, so it needs its own
      // queueMicrotask rethrow to surface consistently rather than escaping the listener instead.
      queueMicrotask(() => {
        throw error
      })
    }
  }

  private async runTick(force: boolean): Promise<void> {
    if (this.stopped) return

    if (this.isChecking) {
      this.pendingForce = this.pendingForce || force
      return
    }

    const tasks = this.options.store.getState().tasks
    if (tasks.length === 0) return

    this.isChecking = true
    const batch = new Map<string, Partial<PendingTask<TType>> | null>()
    try {
      const now = Date.now()
      // Claimed lazily by the first task in this tick that actually needs leadership, then
      // carried forward for the rest of the tick: every task that reaches its own check()
      // re-confirms (and thereby renews) leadership right after, updating `fence` for whichever
      // task comes next, so a later task in the same tick can trust that renewal instead of
      // claiming again immediately beforehand — see the reconfirms below. Stays `undefined` for
      // the whole tick when `crossTabPollLeaderElection` is off.
      let fence: number | undefined
      // Set once any leadership check fails this tick (claim refused, a fence mismatch, or this
      // poller having been stop()ped mid-tick) so every later due task skips straight past its
      // own leadership check instead of redundantly re-attempting one that can only fail the
      // same way again — while still letting tasks that need no leadership at all (pure local
      // expiry bookkeeping, above) keep being processed normally for the rest of this tick.
      let leadershipLost = false

      for (const task of tasks) {
        const handler = this.options.registry[task.type]
        const ttlMs = task.ttlMs ?? this.options.defaultTtlMs
        const expired = now - task.startedAt >= ttlMs

        if (!handler) {
          // No handler to poll with (e.g. removed/renamed since this task was created) — the
          // only thing we can still do for it is let it expire instead of lingering forever.
          // Pure local bookkeeping, no network call — doesn't need leadership.
          if (expired) {
            await this.finalize(task, { status: "expired" }, handler, batch)
          }
          continue
        }

        const interval = handler.pollIntervalMs ?? this.options.defaultPollIntervalMs
        const lastChecked = task.lastCheckedAt ?? task.startedAt
        const due = force || now - lastChecked >= interval
        const finalAttemptDone = this.finalCheckAttempted.has(task.id)

        if (expired && (!handler.finalCheckOnExpiry || finalAttemptDone)) {
          // Same as above: dropping a task that isn't getting a last look is pure local
          // bookkeeping, no network call, doesn't need leadership.
          await this.finalize(task, { status: "expired" }, handler, batch)
          continue
        }

        if (!due && !expired) continue

        if (expired) {
          this.finalCheckAttempted.add(task.id)
        }

        // Cross-tab poll-leader election: claim/renew only right before doing the actual
        // network work — tasks skipped above by the cheap local judgments never touch this,
        // so they don't cost a localStorage round trip or a cross-tab storage-event broadcast
        // just because this tick happened to scan past them. Only the first such task in a tick
        // claims here; every task's post-check reconfirm below already renews the lease (and its
        // fence) for whichever task comes next, so re-claiming again immediately beforehand would
        // just be a redundant localStorage write. Losing the lease here means another tab has
        // already taken over (or this poller has itself been stopped) — skip this and every
        // later due task's network work for the rest of the tick (a new leader, if any, will
        // pick up where this tab left off on its own schedule) without abandoning the tasks
        // after it that need no leadership at all.
        if (this.options.crossTabPollLeaderElection) {
          // Checked unconditionally, before the `fence === undefined` gate below, not inside
          // it: `stop()` can be called from consumer code (e.g. `onResult` calling
          // `poller.stop()`) between two tasks in the same tick, after `fence` already holds an
          // earlier task's still-valid claim. If this check lived inside the `fence ===
          // undefined` branch, it would never run for that later task — `fence` being set
          // would skip the whole block, `handler.check()` would fire anyway (its response
          // still gets discarded by the post-check reconfirm's own `stopped` check, so no data
          // corruption — just a wasted request this check exists to prevent).
          if (leadershipLost || this.stopped) {
            leadershipLost = true
            if (expired) this.finalCheckAttempted.delete(task.id)
            continue
          }
          if (fence === undefined) {
            let claimed: PollLeaseClaimResult
            try {
              claimed = await this.claimLeadership()
            } catch (error) {
              // A rejected claim must not leave this task's finalCheckAttempted entry dangling
              // past this tick — surface the error the same way as before, just without leaking
              // that bookkeeping first (see reconfirmLeadership's matching catch).
              if (expired) this.finalCheckAttempted.delete(task.id)
              throw error
            }
            if (!claimed.leader) {
              leadershipLost = true
              if (expired) this.finalCheckAttempted.delete(task.id)
              continue
            }
            fence = claimed.fence
          }
        }

        let result: PendingTaskCheckResult
        try {
          result = await handler.check(task)
        } catch (error) {
          // handler.check()'s own request duration isn't bounded by the lease renewal cadence
          // above — a single slow call can still outlast pollLeaseTtlMs, letting another tab
          // claim leadership (and possibly already resolve this same task) before this one
          // rejects. Re-confirm leadership before acting on what may now be a stale outcome —
          // including an error outcome, since the failure-count/finalize bookkeeping below
          // would otherwise still mutate state a new leader may have already moved past.
          const reconfirmedOnError = await this.reconfirmLeadership(task, expired, fence)
          if (reconfirmedOnError === false) {
            // Reset `fence` to `undefined`, not just `leadershipLost = true`: the pre-check
            // block above only runs its `leadershipLost` short-circuit while `fence ===
            // undefined` (its normal signal for "haven't claimed yet this tick"). Leaving
            // `fence` at its old, now-stale value would make that condition false for every
            // later task, skipping the short-circuit entirely and letting them call
            // handler.check() despite `leadershipLost` — exactly the redundant network work
            // that flag exists to prevent.
            leadershipLost = true
            fence = undefined
            continue
          }
          fence = reconfirmedOnError

          let intercepted: boolean | void
          try {
            intercepted = this.options.onCheckError?.(error, task)
          } catch (onCheckErrorError) {
            // onCheckError is documented to return a boolean, not throw — a throw here is a
            // consumer callback bug, same category as an `onResult` throw. Don't let it leak
            // this task's `finalCheckAttempted` entry (fall through to the normal handling
            // below as "not intercepted") or take down the tick; surface it the same way
            // `runTickSafely` surfaces any other consumer-callback exception.
            queueMicrotask(() => {
              throw onCheckErrorError
            })
            intercepted = false
          }

          if (intercepted) {
            // Throttle like a normal check so a caller whose pause is asynchronous (e.g. it
            // still needs to call `stop()` itself) doesn't see this task look overdue again on
            // every following tick in the meantime. This check was intercepted rather than
            // genuinely completed, so it shouldn't consume finalCheckOnExpiry's one last-look
            // allowance — clear the flag so a real final check still happens once polling resumes.
            batch.set(task.id, { lastCheckedAt: now })
            this.finalCheckAttempted.delete(task.id)
            break
          }

          if (expired) {
            // The one extra chance finalCheckOnExpiry grants has now been used — expire rather
            // than entering the generic failure-backoff loop.
            await this.finalize(task, { status: "expired" }, handler, batch)
            continue
          }

          const latest = this.getLatestTask(task)
          const failureCount = (latest.failureCount ?? 0) + 1
          if (failureCount >= this.options.maxFailureCount) {
            await this.finalize(task, { status: "error", data: describeError(error) }, handler, batch)
          } else {
            batch.set(task.id, { lastCheckedAt: now, failureCount })
          }
          continue
        }

        // Same staleness concern as the catch branch above, for the success path: a late
        // "pending" response would otherwise silently overwrite a newer leader's more current
        // progress with older numbers (e.g. a percent-complete counter visibly ticking
        // backward), and a late terminal response could finalize a task a new leader has
        // already moved past.
        const reconfirmedOnSuccess = await this.reconfirmLeadership(task, expired, fence)
        if (reconfirmedOnSuccess === false) {
          // See the matching comment in the catch branch above: `fence` must go back to
          // `undefined` too, or the pre-check block's `leadershipLost` short-circuit never runs
          // for any later task this tick.
          leadershipLost = true
          fence = undefined
          continue
        }
        fence = reconfirmedOnSuccess

        if (result.status === "pending") {
          const latest = this.getLatestTask(task)
          batch.set(task.id, {
            lastCheckedAt: now,
            failureCount: 0,
            metadata: { ...latest.metadata, ...result.progress },
          })
          if (expired) {
            // finalCheckOnExpiry's one last look still came back pending — expire quietly now.
            // (status is "expired" here, so finalize() returns before it could ever throw —
            // no try/catch needed, same as the other expiry finalize calls above.)
            await this.finalize(task, { status: "expired" }, handler, batch)
          }
          continue
        }

        await this.finalize(task, { status: result.status, data: result.data }, handler, batch)
      }
    } finally {
      this.flushBatch(batch)
      this.isChecking = false
      if (this.pendingForce && !this.stopped) {
        this.pendingForce = false
        this.runTickSafely(true)
      }
    }
  }
}
