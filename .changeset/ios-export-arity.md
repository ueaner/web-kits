---
"sqlite-wasm-miniprogram": patch
---

Fix initialization on iOS devices: "Exception loading sqlite3 module: sqlite3_aggregate_context() requires 0 argument(s)." On iOS, `WXWebAssembly` reports `length === 0` for every exported function, and the glue's `xWrap` / `xCall` check a function's `length` against its declared parameter count. The build now reads each export's parameter count from `sqlite3.wasm` (also listed as `exportArity` in `assets/manifest.json`), and `initSqlite3` restores `length` on the instance's exports where it is wrong: in place when the runtime allows it, otherwise through a forwarding wrapper. Android and DevTools, where `length` is already right, are untouched. Covered by a simulated runtime in the tests; not yet verified on an iOS device.

Also fixed:

- `initSqlite3` no longer hangs when preparing the instance's exports or handing them to the glue throws: it rejects, and a later call retries. Previously the returned promise stayed pending for good, so every later call got the same stuck promise.
- The glue's own warnings (such as "Ignoring inability to install 'opfs' sqlite3_vfs") now go to `logger`, as documented, and are dropped without one. Before, they went straight to `console.warn`, which on WeChat counts toward the mini program's error reports.
- A missing or non-string `assetsDir` now gives a rejected promise instead of a synchronous throw.
- `restoreArity` corrects only a `length` of 0 (the iOS symptom). A non-zero `length` reported by the runtime is trusted, so a `sqlite3.wasm` copied from a different version is never "corrected" with this build's table.
- The `TextDecoder` fallback decodes an `ArrayBuffer` from another realm instead of reading it as empty.
