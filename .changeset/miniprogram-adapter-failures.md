---
"cross-sqlite-client": patch
---

Mini program adapter: tell failures apart from corruption, and recover cleanly from them.

- **Opening no longer treats a transient failure as a corrupt file.** Running out of memory while loading a snapshot (or any failure without a `SQLITE_CORRUPT` / `SQLITE_NOTADB` result code) used to move the intact current file aside and fall back to the older `.bak` — or, if that failed the same way, start an empty database. Now `initialize()` fails and can be retried, and no file is touched. A file that is actually corrupt is still moved aside and replaced from `.bak` as before.
- **A failed restore after a failed save starts over.** If restoring the last saved snapshot also fails, the adapter now lets go of the database, so the next `initialize()` reopens it from disk instead of returning a client with no database. The error keeps both causes (the save failure, such as a full storage quota, and the restore failure) in an `AggregateError`.
- **`initialize()` right after `close()` waits for the close** and opens the database again, instead of returning the client that the pending close was about to shut.
- **Opening from `.bak` closes the connection it opened** when moving the corrupt file aside or writing the current file back fails, instead of leaking a database-sized block of wasm memory.
- **A failing `select()` saves what it already applied** (e.g. `INSERT … RETURNING; <failing statement>`), like `execute()` and `executeBatch()` already did.
- **A failed statement that changed nothing no longer triggers a save**, so a constraint error is reported as the `DbExecutionError` it is, not masked by a `DbPersistenceError` when saving happens to fail too.
