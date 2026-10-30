---
"sqlite-wasm-miniprogram": minor
"cross-sqlite-client": patch
---

Update `@sqlite.org/sqlite-wasm` to 3.54.1-build1 (SQLite 3.54.1). `sqlite-wasm-miniprogram` bundles the new glue and `sqlite3.wasm` (`.br` 352,905 bytes, up from 348,812); copy the new `dist/assets/` into the mini program package along with it. The prebuilt callback stubs are unchanged. `cross-sqlite-client`'s optional `@sqlite.org/sqlite-wasm` dependency (the web adapter's engine) moves to the same version.
