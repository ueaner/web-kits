import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { PendingTaskPoller, type PendingTaskPollerOptions } from "./engine"
import type { PendingTaskStore } from "./store"
import type { PendingTask } from "./types"

export type { PendingTaskPollerOptions } from "./engine"
export { PendingTaskPoller } from "./engine"

/**
 * Mounts a `PendingTaskPoller` for the lifetime of the component. Re-creates the poller
 * whenever `enabled` or the registry/store identity changes (pass a stable `registry` and
 * `store` — module-level singletons, not literals re-created per render).
 *
 * The engine has no notion of auth/sessions — if the poller should only run while the user
 * is authenticated, compute `enabled` from your own auth state (e.g. `enabled: !!token`) and
 * pass it in; the hook tears the poller down whenever `enabled` goes false.
 *
 * Also forces an immediate re-check when the tab regains visibility, so a task doesn't
 * sit stale for a full `pollTickMs` after the user tabs back in.
 *
 * This hook renders nothing and returns nothing — it's a side-effect-only driver, meant
 * to be mounted once near the app root.
 */
export function usePendingTaskPoller<TType extends string = string>(
  options: PendingTaskPollerOptions<TType> & { enabled?: boolean },
): void {
  const { enabled = true, ...pollerOptions } = options
  const optionsRef = useRef(pollerOptions)
  optionsRef.current = pollerOptions

  useEffect(() => {
    if (!enabled) return

    // Every callback reads through `optionsRef` at call time, not at poller-construction
    // time, so a new `onResult`/`onCheckError`/etc. closure from a re-render takes effect
    // immediately without needing to tear down and rebuild the poller (only `store`/`registry`
    // identity and `enabled` do that, since those genuinely need a fresh instance). This must
    // cover every callback option `PendingTaskPollerOptions` adds, not just the ones that
    // existed when this hook was first written — a callback left out of this list (only
    // reachable via the initial `...optionsRef.current` spread) would silently pin itself to
    // whatever closure was captured at mount, which defeats the whole point for anything that
    // reads live app state (e.g. `acceptRelayedResult` checking the currently signed-in user).
    const poller = new PendingTaskPoller({
      ...optionsRef.current,
      onResult: (detail) => optionsRef.current.onResult?.(detail),
      onCheckError: (error, task) => optionsRef.current.onCheckError?.(error, task),
      claimResultOnce: (task) => (optionsRef.current.claimResultOnce ? optionsRef.current.claimResultOnce(task) : true),
      acceptRelayedResult: (detail) => optionsRef.current.acceptRelayedResult?.(detail) ?? true,
      onLeaderChange: (isLeader) => optionsRef.current.onLeaderChange?.(isLeader),
      onTick: (info) => optionsRef.current.onTick?.(info),
      // An object channel rather than a bare callback, so it forwards method-by-method; the
      // `?? console` fallback mirrors the engine's own default when no logger is passed.
      logger: { warn: (message) => (optionsRef.current.logger ?? console).warn(message) },
    })
    poller.start()

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        poller.forceCheckAll()
      }
    }
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility)
      poller.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pollerOptions.store, pollerOptions.registry])
}

/** Returns `previous` instead of `next` when both are arrays holding the same elements in the
 *  same order — so a selector that builds a fresh array each call (`tasks.filter(...)`) still
 *  hands back a stable reference when the result hasn't actually changed. */
function reuseIfShallowEqual<T>(previous: unknown, next: T): T {
  if (
    Array.isArray(previous) &&
    Array.isArray(next) &&
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
  ) {
    return previous as T
  }
  return next
}

/**
 * Subscribes a component to a store's task list — re-renders only when the store changes (a
 * write in this tab, or another tab's write: subscribing is what keeps the store syncing with
 * other tabs, no poller needed). Returns `tasks` itself by default; pass `select` to derive
 * something from it instead (a filter, a count, a single task by id).
 *
 * `select` re-runs when `tasks` changes or when `select` itself is a different function (an
 * inline one is, on every render). An array result that holds the same elements in the same
 * order as the last rendered one is returned as that same array, so a filter stays
 * referentially stable even when written inline. Any other freshly built value (an object, a
 * mapped array of new objects) is only stable across re-renders if `select` is too — hoist it
 * out of the component or wrap it in `useCallback` before using such a result as an
 * effect/memo dependency.
 *
 * During SSR and hydration it returns an empty list (the server has no `localStorage`), then
 * re-renders with the persisted tasks once hydrated — so server and client markup match.
 *
 * Mutators aren't part of this — call them through `store.getState()`, e.g.
 * `store.getState().removeTask(id)`.
 */
export function usePendingTasks<TType extends string = string>(store: PendingTaskStore<TType>): PendingTask<TType>[]
export function usePendingTasks<TType extends string, TSelected>(
  store: PendingTaskStore<TType>,
  select: (tasks: PendingTask<TType>[]) => TSelected,
): TSelected
export function usePendingTasks<TType extends string, TSelected>(
  store: PendingTaskStore<TType>,
  select?: (tasks: PendingTask<TType>[]) => TSelected,
): TSelected | PendingTask<TType>[] {
  // The last *committed* result, for reuseIfShallowEqual across a `select` identity change.
  // Only ever written in an effect (never during render), so a render React discards —
  // concurrent rendering does that — can't leave a value behind that was never shown.
  const committed = useRef<{ value: TSelected | PendingTask<TType>[] } | null>(null)

  // useSyncExternalStore requires each snapshot getter to return the same value until the
  // store changes (it calls it more than once per render and compares by identity) — a
  // `select` returning a fresh array/object each call would otherwise loop forever. So each
  // getter memoizes on the `tasks` reference (replaced only when the store changes) inside its
  // own closure, rebuilt whenever `store` or `select` changes — the same approach as React's
  // own `use-sync-external-store/with-selector`.
  const [getSnapshot, getServerSnapshot] = useMemo(() => {
    const memoize = (readTasks: () => PendingTask<TType>[]) => {
      let memo: { tasks: PendingTask<TType>[]; selected: TSelected | PendingTask<TType>[] } | undefined
      return () => {
        const tasks = readTasks()
        if (memo && memo.tasks === tasks) return memo.selected
        const computed = select ? select(tasks) : tasks
        // Compared against this getter's own last result, or — right after `select` changed
        // and this closure was rebuilt — the last committed one.
        const selected = reuseIfShallowEqual(memo ? memo.selected : committed.current?.value, computed)
        memo = { tasks, selected }
        return selected
      }
    }
    // Per-hook (not shared), plain array: a consumer mutating what it was handed during SSR
    // behaves the same as on the client instead of throwing on a frozen shared constant.
    const serverTasks: PendingTask<TType>[] = []
    return [memoize(() => store.getState().tasks), memoize(() => serverTasks)] as const
  }, [store, select])

  const subscribe = useCallback((onStoreChange: () => void) => store.subscribe(onStoreChange), [store])
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useEffect(() => {
    committed.current = { value }
  }, [value])
  return value
}
