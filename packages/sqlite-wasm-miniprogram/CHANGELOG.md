# sqlite-wasm-miniprogram

## 0.1.0

### Minor Changes

- 85fb5ed: First release: the official `@sqlite.org/sqlite-wasm` 3.53.4-build1 (SQLite 3.53.4) built to run in WeChat mini programs through `WXWebAssembly` — shims injected at bundle time for `WebAssembly` / `URL` / `URLSearchParams`, cross-realm fixes for exported functions and table errors, and prebuilt callback stubs. `initSqlite3({ webAssembly: WXWebAssembly, assetsDir })` returns the same `sqlite3` object as `sqlite3InitModule()`; copy `dist/assets/` (`sqlite3.wasm.br` or `sqlite3.wasm`, `stubs/`) into the mini program package. Verified in the WeChat DevTools simulator, not yet on devices.
