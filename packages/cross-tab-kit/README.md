# cross-tab-kit

Framework-agnostic cross-tab coordination for the browser: a Web Locks mutex (waiting and
skip-if-busy flavors), leader election (timer-driven or caller-driven), and a TTL "claim
once" dedupe cache. Zero runtime dependencies, zero framework assumptions — plain functions
you can drop into any browser codebase that has multiple tabs open against the same origin
and needs them to coordinate: run something in only one of them, elect one as a leader, or
make sure an action fires exactly once no matter how many tabs race to trigger it.

## Install

```bash
pnpm add cross-tab-kit
```

## Usage

### Refresh an auth token in only one tab (`tryWithTabLock`)

The skip-if-busy mutex: if another tab is already refreshing, don't queue up behind it —
every queued tab refreshing once each is how refresh endpoints get rate-limited.

```ts
import { tryWithTabLock } from "cross-tab-kit"

async function getValidToken(): Promise<string> {
  const cached = readCachedToken()
  if (cached) return cached

  const result = await tryWithTabLock("my-app:refresh-token", (ctx) => refreshToken(ctx.timeoutSignal))
  if (result.acquired) return result.value

  // Another tab is refreshing right now. Wait for the new token it writes to localStorage —
  // the `storage` event fires in every *other* tab on write, which is exactly this case —
  // but with a timeout: if the refreshing tab fails, don't hang forever; try again yourself.
  const token = await waitForStorageValue("my-app:token", { timeoutMs: 5_000 })
  if (token === null) return getValidToken() // the refresher failed — step up
  return token
}
```

`waitForStorageValue` is a few lines of caller-side code (a `storage` event listener plus a
timeout), not part of this package — waiting and events are not coordination primitives.

### Keep a single WebSocket / poller across tabs (`createLeadershipLoop`)

Timer-driven leader election: one tab holds leadership, renews it on an interval
(default `ttlMs / 3`), and every other tab stands by and takes over when the leader's lease
lapses (closed, crashed, or frozen tabs never block takeover — the TTL is the fallback).

```ts
import { createLeadershipLoop } from "cross-tab-kit"

const stop = createLeadershipLoop(
  "my-app:ws-leader",
  30_000,
  (ctx) => {
    // This tab is the leader. ctx.signal aborts the moment leadership is lost —
    // link it into the work so losing leadership cancels it, not just ignores it.
    const socket = new WebSocket("wss://example.com/stream")
    ctx.signal.addEventListener("abort", () => socket.close(), { once: true })
  },
  { onLeadershipLost: () => console.log("leadership moved to another tab") },
)

// On shutdown: stop() — idempotent; stops the timer and releases the lease.
```

`onLeadership` fires once per tenure — including regaining leadership after losing it —
never twice for the same tenure. Note that backgrounded tabs get their timers throttled:
with a `ttlMs` under ~3 minutes, leadership drifts to a visible tab (usually what you want);
choose a larger `ttlMs` if leadership must survive backgrounding.

### Caller-paced leadership for a polling engine (`createLeadershipGate`)

The manual transmission: no internal timer, so an idle tick produces zero storage traffic,
and claiming happens exactly where the caller puts it — e.g. inside a poll tick, right
before the first network request.

```ts
import { createLeadershipGate } from "cross-tab-kit"

const gate = createLeadershipGate("my-app:poll-leader", 8_000)

async function runTick() {
  const tenure = await gate.acquire()
  if (!tenure) return // another tab leads this tick — skip the network work
  const response = await fetch("/api/pending", { signal: tenure.signal })
  // Re-confirm before using the response: a slow request may span a leadership change.
  if (!(await tenure.isStillValid())) return
  await handle(response)
}

// On shutdown: gate.release() — synchronous, best-effort tombstone.
```

`tenure.signal` aborts as soon as another tab's claim lands (the gate listens for the
`storage` event that claim's write causes), not just when you next re-check.

### Fire something exactly once across tabs (`createTtlDedupeCache`)

```ts
import { createTtlDedupeCache, withTabLock } from "cross-tab-kit"

const notified = createTtlDedupeCache("my-app:notified-once", 24 * 60 * 60 * 1000, {
  maxEntries: 1_000, // optional bound: evicts the oldest-claimed entries
})

// claim() is a plain unlocked read-modify-write — wrap it in withTabLock when the claim
// must be atomic across tabs. The wait is short-bounded: a claim is microseconds of work,
// so a long wait means a wedged holder, not a busy one.
if (await withTabLock("my-app:notified-once", () => notified.claim(orderId), { waitTimeoutMs: 2_000 })) {
  showToast("Order confirmed")
}

// Side-effect-free membership check, e.g. for UI asking "did we already notify?"
if (notified.has(orderId)) disableResendButton()
```

## Core concepts

- **`withTabLock(name, operation, options)`** — runs `operation` under a named [Web Locks
  API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) lock
  (`navigator.locks`), so only one open tab executes it at a time. Falls back to running
  `operation` un-locked when Web Locks isn't available (older browsers, non-secure contexts).
  `options` is required because it carries `waitTimeoutMs` — the bound on _waiting_ for the
  lock (rejects with a `TimeoutError`; pass `Infinity` to wait unbounded, explicitly).
  `options.signal` also aborts that wait (rejects with an `AbortError`). `options.timeoutMs`
  is the separate bound on the _operation_: it rejects with a `TimeoutError`, releases the
  lock, and aborts `ctx.timeoutSignal` if `operation` hasn't settled in time — the operation
  itself isn't cancelled (JS can't interrupt arbitrary code), so after a timeout two tabs
  can briefly be inside `operation` at once; keep side effects idempotent.
- **`tryWithTabLock(name, operation, options?)`** — the skip-if-busy sibling: resolves to
  `{ acquired: true, value }` or `{ acquired: false }` instead of queueing behind the
  holder (it never queues, so it takes no `waitTimeoutMs`). On the no-Web-Locks fallback
  there is no lock to contend for, so it always reports `acquired: true`.
- **`createLeadershipLoop(storageKey, ttlMs, onLeadership, options?)`** — timer-driven
  leader election for a standing role (a poller, a shared socket). `onLeadership(ctx)` fires
  once per tenure; `ctx = { fence, signal, isStillLeader() }`. Returns a `stop()` function.
  A tick that can't acquire the arbitration lock within `waitTimeoutMs` (default `ttlMs`)
  fails and logs — the loop self-heals on the next tick.
- **`createLeadershipGate(storageKey, ttlMs, options?)`** — the same machinery without a
  timer: `acquire()` returns a `Tenure` (`{ fence, signal, isStillValid() }`) or null, and
  rejects with a `TimeoutError` if the arbitration lock wait exceeds `waitTimeoutMs`;
  `release()` is a synchronous best-effort tombstone.
- **`createTtlDedupeCache(storageKey, ttlMs, options?)`** — a localStorage-backed,
  TTL-expiring "claim once" cache: `claim(id)` returns `true` the first time `id` is claimed
  within the TTL window, `false` on any repeat (the window is fixed from the first claim — a
  repeat doesn't extend it). `has(id)` queries without claiming; `clear()` wipes every
  claim. `options.maxEntries` bounds the cache, evicting the oldest-claimed entries.
- **Misconfiguration fails fast**: an invalid `ttlMs` / `renewIntervalMs` / `maxEntries` /
  timeout option throws a `RangeError` at construction or call time — caught by the app's
  first start or first test — instead of silently degrading coordination.
- **`Logger`** — every `options.logger` in this package is the minimal
  `{ warn(message): void }`, so `console` or any logger you already have is assignable
  directly.

## The `advanced` subpath

The primitives the scenario-level API is built on, for callers composing their own
coordination:

```ts
import {
  createPollLeaseClaimer,
  generatePollOwnerId,
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  type PollLeaseClaimer,
  type PollLeaseClaimResult,
  type PollLeaseClaimerOptions,
  type Logger,
} from "cross-tab-kit/advanced"
```

`createPollLeaseClaimer(storageKey, ttlMs)` is the renewable, localStorage-backed lease
underneath both leadership APIs: `claim(ownerId)` returns `{ leader: true, fence }` or
`{ leader: false }` — capture the `fence` to later tell "nobody holds this lease right now"
apart from "it has been mine, continuously, since I captured this fence." `claim`/`release`
are synchronous, are not internally locked (wrap them in `withTabLock` for cross-tab
atomicity — that composition is exactly what `createLeadershipGate` already does), fail
open on storage write failure, and `release` writes an expired tombstone rather than
deleting, so the fence keeps strictly increasing. `safeGetItem`/`safeSetItem`/
`safeRemoveItem` are the thin localStorage wrappers every primitive here is built on:
they degrade safely instead of throwing, whether storage is unavailable entirely (SSR, no
`window`) or the call itself throws (quota exceeded, Safari private browsing, storage
disabled).

## Pitfalls

- **Choosing `waitTimeoutMs`**: for short critical sections (a claim, a compare-and-write),
  wait briefly — microseconds of work mean a long wait indicates a wedged holder, so a short
  bound (hundreds of ms to a few seconds) surfaces it as a `TimeoutError` instead of
  stalling every same-name waiter across all tabs. For genuinely queueing workloads, pass
  `Infinity` explicitly — that's the deliberate spelling of "wait as long as it takes".
- **Network requests inside `operation`**: pair them with `timeoutMs` and pass
  `ctx.timeoutSignal` to `fetch` — otherwise a hung request holds the lock until the tab
  dies, and every other tab's waiter hits its own `waitTimeoutMs`.
- **Never nest a same-name lock**: Web Locks are not re-entrant, so
  `withTabLock("a", () => withTabLock("a", ...))` (directly or transitively) deadlocks —
  surfacing as the inner call's `waitTimeoutMs` rejection, whose message names the nested
  call as the cause. When acquiring multiple lock names, use one consistent order everywhere.
- **Constructor arguments are validated**: `ttlMs`, `renewIntervalMs`, `maxEntries`, and the
  timeout options throw `RangeError` on invalid values (`0`, `NaN`, `Infinity` where
  unbounded would be a bug, `renewIntervalMs >= ttlMs`) — a misconfigured loop that renews
  at or past its TTL would flap leadership between tabs.

## Runtime environment notes

- **Web Locks unavailable**: `withTabLock` degrades to running `operation` un-locked — every
  tab runs it, no mutual exclusion; `tryWithTabLock` reports `acquired: true`. The
  leadership APIs keep working (the lease is storage-based, not lock-based) but their claims
  can race across tabs, briefly producing two leaders — the TTL and fence keep it
  self-healing rather than wrong.
- **Web Locks deadlock and freeze pitfalls**: Web Locks are not re-entrant — nesting
  `withTabLock` under the same name (directly or transitively) deadlocks, and so does
  acquiring two lock names in inconsistent order across code paths. The wait is still
  bounded in both cases: `waitTimeoutMs` rejects the waiter (naming the nested call when
  this tab itself holds the lock), and `signal` makes the wait abortable — `timeoutMs`
  alone can't rescue either case, since it only bounds `operation`, never the wait. A tab
  frozen in the back/forward cache also keeps holding any lock it already owns until the
  browser discards it, blocking other tabs waiting on the same name — which is exactly what
  `waitTimeoutMs` bounds. The lease-based leadership APIs are immune to the freeze case by
  design (the tenure expires on its own); a long-lived `withTabLock` critical section is
  not.
- **localStorage unavailable or throwing**: every primitive here degrades safely. A lease or
  dedupe cache backed by storage that can't persist writes still returns results, just
  without the cross-tab guarantee — the same "coordination becomes best-effort, not wrong"
  tradeoff `withTabLock`'s own degradation makes.
- **Background tab throttling**: Chrome intensively throttles tabs hidden for over 5
  minutes. With `createLeadershipLoop`, a backgrounded leader whose `ttlMs` is under ~3
  minutes stops renewing and leadership drifts to a visible tab — usually the desired
  behavior; use `ttlMs >= 3 minutes` to keep leadership in a backgrounded tab.

## What's deliberately out of scope

- Anything above these primitives — task queues, polling engines, retry/backoff policies,
  notification dispatch. This package only provides the coordination building blocks; what
  you coordinate is entirely up to you.
- Strong consistency, cross-browser/cross-device coordination, message broadcasting
  (`BroadcastChannel` is natively enough), and high-frequency state sync.
- `steal`, read-write locks, and `lock inspection` from the Web Locks API — pure additions
  if a real need shows up.

## Contributing

Issues and PRs welcome at <https://github.com/ueaner/cross-tab-kit>.

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run lint
```

## License

MIT
