---
"cross-sqlite-client": minor
---

New `cross-sqlite-client/adapters/miniprogram`: SQLite in WeChat mini programs on the same official `@sqlite.org/sqlite-wasm` engine as the web and memory adapters (the engine build comes from the new `sqlite-wasm-miniprogram` package). The database lives in memory and is saved as a snapshot to the mini program's user data directory; a write resolves only after the save, a failed save rolls memory back to the last saved snapshot and throws the new `DbPersistenceError`, and the previous good version is kept as `.bak` and used when the current file fails `PRAGMA quick_check` on open (damaged files are moved aside, never deleted).

`transactionalExecutor` is now exported from the root entry (`import { transactionalExecutor } from "cross-sqlite-client"`); `cross-sqlite-client/adapters/web` still re-exports it, so existing imports keep working, but importing it from `adapters/web` pulls in the web adapter's sqlite-wasm worker code.

Fix: writes started in the same task are now merged into one `onWrite` notification even when they finish at different times, as documented. Before, only writes that finished in the same task were merged, so on adapters whose writes wait for I/O (the web adapter's worker round-trips, the new mini program adapter's saves) `Promise.all([execute(a), execute(b)])` notified once per write.
