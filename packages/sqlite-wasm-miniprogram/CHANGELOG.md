# sqlite-wasm-miniprogram

## 0.1.1

### Patch Changes

- 907b28e: Bundle `TextEncoder` / `TextDecoder` for real devices. The glue converts strings to and from wasm memory with them, and mini programs and mini games on devices have neither (WeChat DevTools does, which is why 0.1.0 only failed on devices: "Exception loading sqlite3 module: TextDecoder is not defined"). They are injected at bundle time like the other shims, use the native implementations when present, and fall back to a pure-JS UTF-8 codec that decodes exactly like `TextDecoder` (invalid sequences included). Verified on an Android device.

## 0.1.0

### Minor Changes

- 85fb5ed: First release: the official `@sqlite.org/sqlite-wasm` 3.53.4-build1 (SQLite 3.53.4) built to run in WeChat mini programs through `WXWebAssembly` — shims injected at bundle time for `WebAssembly` / `URL` / `URLSearchParams`, cross-realm fixes for exported functions and table errors, and prebuilt callback stubs. `initSqlite3({ webAssembly: WXWebAssembly, assetsDir })` returns the same `sqlite3` object as `sqlite3InitModule()`; copy `dist/assets/` (`sqlite3.wasm.br` or `sqlite3.wasm`, `stubs/`) into the mini program package. Verified in the WeChat DevTools simulator, not yet on devices.
