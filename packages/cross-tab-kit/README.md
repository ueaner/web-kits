# cross-tab-kit

Framework-agnostic cross-tab coordination primitives for the browser: a Web Locks mutex, a
renewable poll-leader lease, a TTL "claim once" dedupe cache, and safe localStorage helpers.
Zero runtime dependencies, zero framework assumptions — plain functions you can drop into any
browser codebase that has multiple tabs open against the same origin and needs them to
coordinate: run something in only one of them, elect one as a leader, or make sure an action
fires exactly once no matter how many tabs race to trigger it.

## Install

```bash
pnpm add cross-tab-kit
```

## Core concepts

- **`withTabLock(name, operation, options?)`** — runs `operation` under a named [Web Locks
  API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) lock
  (`navigator.locks`), so only one open tab executes it at a time. Falls back to running
  `operation` un-locked when Web Locks isn't available (older browsers, non-secure contexts).
  `options.signal` aborts the _wait_ for the lock (rejects with an `AbortError`);
  `options.timeoutMs` rejects with a `TimeoutError` and releases the lock if `operation` hasn't
  settled in time — so a hung operation can't block every other tab forever (the operation
  itself isn't cancelled; it keeps running in the background and its result is discarded).
- **`createPollLeaseClaimer(storageKey, ttlMs, options?)`** — a renewable, localStorage-backed
  lease: at most one owner is considered current at a time, but that fact expires on its own
  (`ttlMs` after the last successful `claim`) rather than requiring an explicit release, so an
  owner that stops renewing (a closed, crashed, or frozen tab) can't permanently block every
  other tab from taking over. `claim(ownerId)` returns a `fence` (a generation number) alongside
  `{ leader: true }` — capture it to later tell "is nobody else holding this lease right now"
  apart from "has it been mine, continuously, since I captured this fence." Not itself
  cross-tab-atomic on its own — compose it with `withTabLock` for that (see below).
- **`createTtlDedupeCache(storageKey, ttlMs)`** — a localStorage-backed, TTL-expiring "claim
  once" cache: `claim(id)` returns `true` the first time `id` is claimed within the TTL window,
  `false` on any repeat — e.g. to make sure a cross-tab notification or tracking event fires
  exactly once even if several tabs race to process the same id. The TTL window is fixed from
  the first claim — a repeat `claim(id)` doesn't extend it. `clear()` wipes every claim.
- **`safeGetItem` / `safeSetItem` / `safeRemoveItem`** — thin `localStorage` wrappers that
  degrade safely instead of throwing, whether `localStorage` is unavailable entirely (SSR, no
  `window`) or the call itself throws (quota exceeded, Safari private browsing, storage
  disabled, cookies/site data blocked). Every other primitive in this package is built on these;
  reach for them directly if you're building your own localStorage-backed primitive.

## Usage

```ts
import { withTabLock, createPollLeaseClaimer, createTtlDedupeCache, generatePollOwnerId } from "cross-tab-kit"

// Mutex: only one open tab runs this at a time.
await withTabLock("my-app:sync-fcm-token", async () => {
  await registerPushToken()
})

// Leader election: only one open tab acts as "the poller" at any moment.
const lease = createPollLeaseClaimer("my-app:poll-leader", 30_000)
const ownerId = generatePollOwnerId()
const result = await withTabLock("my-app:poll-leader", () => lease.claim(ownerId))
if (result.leader) {
  // this tab is the leader until the lease's TTL, unless it keeps renewing by claim()-ing again
}

// Dedupe: fire an event exactly once even if two tabs finish the same work concurrently.
const notified = createTtlDedupeCache("my-app:notified-once", 24 * 60 * 60 * 1000)
if (await withTabLock("my-app:notified-once", () => notified.claim(orderId))) {
  showToast("Order confirmed")
}
```

`withTabLock` and `createPollLeaseClaimer`/`createTtlDedupeCache` are deliberately separate: the
lease and dedupe cache are themselves plain, unlocked "read → decide → write" primitives — you
choose whether and how to wrap a given `claim()` call in `withTabLock`, rather than the package
forcing one locking strategy on every caller.

## Runtime environment notes

- **Web Locks unavailable**: `withTabLock` degrades to running `operation` un-locked — every tab
  runs it, no mutual exclusion. `createPollLeaseClaimer`/`createTtlDedupeCache` don't depend on
  Web Locks themselves, but composing them with a degraded `withTabLock` means their own
  read-modify-write can race across tabs. This is a real availability/consistency tradeoff for a
  caller in that environment to make, not something this package can paper over.
- **localStorage unavailable or throwing**: every primitive here degrades safely (see
  `safeGetItem`/`safeSetItem`/`safeRemoveItem`'s own doc comments for the specific failure mode
  of each). A `createPollLeaseClaimer`/`createTtlDedupeCache` backed by storage that can't
  persist writes still returns results, just without the cross-tab guarantee — the same
  "coordination becomes best-effort, not wrong" tradeoff `withTabLock`'s own degradation makes.

## What's deliberately out of scope

- Anything above these primitives — task queues, polling engines, retry/backoff policies,
  notification dispatch. This package only provides the coordination building blocks; what you
  coordinate is entirely up to you.
- An IndexedDB-backed exclusive-resource lock with loss detection (`assertOwned()`), for cases
  where degrading to "two tabs both think they own it" isn't acceptable even when Web Locks is
  unavailable — this package's `createPollLeaseClaimer` accepts that degradation by design (see
  "Runtime environment notes" above); a caller that can't may need a heavier primitive than what
  this package provides.

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
