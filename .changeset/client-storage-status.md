---
"cross-sqlite-client": minor
---

`DbClient` gets a read-only `storage` that says where the data actually lives: `{ persistent: true }` on an OPFS file or Tauri, `{ persistent: false, reason }` when the web adapter fell back to memory (`"not-cross-origin-isolated"`, `"opfs-unsupported"`, `"opfs-unavailable"`, `"open-failed"`) and on the memory adapter (`"memory-adapter"`). Before `initialize()`, after `close()` and after a failed `initialize()` it is `{ persistent: false, reason: "not-initialized" }`, so it never claims persistence with nothing open. Apps can now tell the user their data won't be kept, instead of the fallback only showing up as a `logger.warn`.

Also fixed: when the OPFS file failed to open and the web adapter fell back to memory, it kept the cross-tab lock it had taken for the OPFS file until `close()`, so that tab blocked every other tab from opening the database (`DbTabLockError`). It now releases the lock when it falls back.

**Breaking for hand-written clients:** `storage` is a required member of `DbClient`, so a stub or wrapper that implements `DbClient` itself must add it (for example `storage: { persistent: true }`).
