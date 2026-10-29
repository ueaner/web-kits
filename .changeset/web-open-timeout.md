---
"cross-sqlite-client": minor
---

The web adapter no longer hangs when opening the OPFS database never answers. `timeoutMs` (default 15 s) now also bounds the `open` of the database file, not only the worker becoming ready. When it runs out, the stuck worker is terminated and the database opens in memory in a new worker, with a warning and `client.storage` set to `{ persistent: false, reason: "open-timeout" }` (new `MemoryFallbackReason`); with `fallbackToMemory: false` `initialize()` rejects with `DbInitializationError` instead. Before, `initialize()` stayed pending forever, with no warning and no fallback.

This happens when sqlite-wasm's OPFS async proxy worker stops answering: in Playwright's WebKit, `Atomics.waitAsync` never settles, so the proxy never picks up the `open`, and the sqlite worker waits for it in `Atomics.wait` for good.

**Type change:** `MemoryFallbackReason` gains `"open-timeout"`; an exhaustive `switch` over it needs the new case.
