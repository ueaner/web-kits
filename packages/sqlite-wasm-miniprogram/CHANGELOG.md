# sqlite-wasm-miniprogram

## 0.2.0

### Minor Changes

- ecbf599: Update `@sqlite.org/sqlite-wasm` to 3.54.1-build1 (SQLite 3.54.1). `sqlite-wasm-miniprogram` bundles the new glue and `sqlite3.wasm` (`.br` 352,905 bytes, up from 348,812); copy the new `dist/assets/` into the mini program package along with it. The prebuilt callback stubs are unchanged. `cross-sqlite-client`'s optional `@sqlite.org/sqlite-wasm` dependency (the web adapter's engine) moves to the same version.

### Patch Changes

- ecbf599: Initialize on iOS devices without installing any callback ([#10](https://github.com/ueaner/web-kits/issues/10)). 0.1.2 fixed the first failure there (`length === 0` on exported functions) but not the second: iOS's `WXWebAssembly` exposes exports as JS wrapper functions, which the wasm function table rejects ("Table.set(): Argument 1 must be null or a WebAssembly function"), and the glue installed 28 callbacks during init. 0.1.2's "Fix initialization on iOS devices" therefore overstated it: init still failed on iOS, one step later. Now:

  - The JS-implemented VFSes are left out through the glue's `sqlite3ApiConfig.disable.vfs` (kvvfs's JS methods and the OPFS family): none works in a mini program, and they accounted for 27 of the callbacks. This also ends the "Ignoring inability to install 'opfs' sqlite3_vfs" warnings.
  - `oo1.DB`'s SQL trace callback is installed the first time a database is opened with the `"t"` flag instead of unconditionally at init (a bundle-time rewrite of the glue; the build fails if the glue's code no longer matches).

  APIs where SQLite calls back into JS (`create_function`, hooks, `trace_v2` / the `"t"` flag, JS VFSes, …) still can't work on iOS; the README lists them. Reads, writes, transactions, export and `sqlite3_deserialize` — everything `cross-sqlite-client`'s mini program adapter uses — need no callback. The tests now simulate both iOS behaviors, and initialization no longer fails on iOS devices in WeChat's cloud testing.

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
