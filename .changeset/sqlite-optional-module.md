---
"sqlite-wasm-miniprogram": patch
---

Initialize on iOS environments whose `WXWebAssembly` has no `Module` (seen on an iPhone 14 Pro with iOS 18.5, WeChat 8.0.56 and base library 3.7.12; an iPhone 16 Pro with iOS 26 has it, and which of these decides is not known). `initSqlite3` rejected with "webAssembly is missing Module (pass WXWebAssembly)", so the database never opened there. WeChat documents only `instantiate`, `Memory` and `Table`, and `Module` / `Instance` are used only for the callback stubs, which iOS can't use anyway. `initSqlite3` now checks only `instantiate`, `Memory` and `Table`; `Module` and `Instance` are optional in `MiniProgramWebAssembly`, and installing a JS callback without them throws "this WXWebAssembly has no Module, so SQLite cannot call back into JS here …". The tests simulate a runtime without `Module` (and without both), on iOS-like exports, through `cross-sqlite-client`'s mini program adapter end to end.
