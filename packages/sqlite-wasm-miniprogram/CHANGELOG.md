# sqlite-wasm-miniprogram

## 0.1.2

### Patch Changes

- 7775a6c: Fix initialization on iOS devices: "Exception loading sqlite3 module: sqlite3_aggregate_context() requires 0 argument(s)." On iOS, `WXWebAssembly` reports `length === 0` for every exported function, and the glue's `xWrap` / `xCall` check a function's `length` against its declared parameter count. The build now reads each export's parameter count from `sqlite3.wasm` (also listed as `exportArity` in `assets/manifest.json`), and `initSqlite3` restores `length` on the instance's exports where it is wrong: in place when the runtime allows it, otherwise through a forwarding wrapper. Android and DevTools, where `length` is already right, are untouched. Covered by a simulated runtime in the tests; not yet verified on an iOS device.

  Also fixed:

  - `initSqlite3` no longer hangs when preparing the instance's exports or handing them to the glue throws: it rejects, and a later call retries. Previously the returned promise stayed pending for good, so every later call got the same stuck promise.
  - The glue's own warnings (such as "Ignoring inability to install 'opfs' sqlite3_vfs") now go to `logger`, as documented, and are dropped without one. Before, they went straight to `console.warn`, which on WeChat counts toward the mini program's error reports.
  - A missing or non-string `assetsDir` now gives a rejected promise instead of a synchronous throw.
  - `restoreArity` corrects only a `length` of 0 (the iOS symptom). A non-zero `length` reported by the runtime is trusted, so a `sqlite3.wasm` copied from a different version is never "corrected" with this build's table.
  - The `TextDecoder` fallback decodes an `ArrayBuffer` from another realm instead of reading it as empty.

## 0.1.1

### Patch Changes

- 907b28e: Bundle `TextEncoder` / `TextDecoder` for real devices. The glue converts strings to and from wasm memory with them, and mini programs and mini games on devices have neither (WeChat DevTools does, which is why 0.1.0 only failed on devices: "Exception loading sqlite3 module: TextDecoder is not defined"). They are injected at bundle time like the other shims, use the native implementations when present, and fall back to a pure-JS UTF-8 codec that decodes exactly like `TextDecoder` (invalid sequences included). Verified on an Android device.

## 0.1.0

### Minor Changes

- 85fb5ed: First release: the official `@sqlite.org/sqlite-wasm` 3.53.4-build1 (SQLite 3.53.4) built to run in WeChat mini programs through `WXWebAssembly` — shims injected at bundle time for `WebAssembly` / `URL` / `URLSearchParams`, cross-realm fixes for exported functions and table errors, and prebuilt callback stubs. `initSqlite3({ webAssembly: WXWebAssembly, assetsDir })` returns the same `sqlite3` object as `sqlite3InitModule()`; copy `dist/assets/` (`sqlite3.wasm.br` or `sqlite3.wasm`, `stubs/`) into the mini program package. Verified in the WeChat DevTools simulator, not yet on devices.
