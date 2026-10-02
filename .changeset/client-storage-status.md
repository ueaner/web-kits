---
"cross-sqlite-client": minor
---

`DbClient` gets a read-only `storage` that says where the data actually lives: `{ persistent: true }` on an OPFS file or Tauri, `{ persistent: false, reason }` when the web adapter fell back to memory (`"not-cross-origin-isolated"`, `"opfs-unsupported"`, `"opfs-unavailable"`, `"open-failed"`) and on the memory adapter (`"memory-adapter"`). Apps can now tell the user their data won't be kept, instead of the fallback only showing up as a `logger.warn`.

**Breaking for hand-written clients:** `storage` is a required member of `DbClient`, so a stub or wrapper that implements `DbClient` itself must add it (for example `storage: { persistent: true }`).
