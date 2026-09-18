import { useEffect, useRef } from "react"
import { PendingTaskPoller, type PendingTaskPollerOptions } from "./engine"

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
      claimResultOnce: (task) =>
        optionsRef.current.claimResultOnce ? optionsRef.current.claimResultOnce(task) : true,
      acceptRelayedResult: (detail) => optionsRef.current.acceptRelayedResult?.(detail) ?? true,
      onLeaderChange: (isLeader) => optionsRef.current.onLeaderChange?.(isLeader),
      onTick: (info) => optionsRef.current.onTick?.(info),
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
