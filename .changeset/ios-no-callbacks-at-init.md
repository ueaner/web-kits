---
"sqlite-wasm-miniprogram": patch
---

Initialize on iOS devices without installing any callback ([#10](https://github.com/ueaner/web-kits/issues/10)). 0.1.2 fixed the first failure there (`length === 0` on exported functions) but not the second: iOS's `WXWebAssembly` exposes exports as JS wrapper functions, which the wasm function table rejects ("Table.set(): Argument 1 must be null or a WebAssembly function"), and the glue installed 28 callbacks during init. 0.1.2's "Fix initialization on iOS devices" therefore overstated it: init still failed on iOS, one step later. Now:

- The JS-implemented VFSes are left out through the glue's `sqlite3ApiConfig.disable.vfs` (kvvfs's JS methods and the OPFS family): none works in a mini program, and they accounted for 27 of the callbacks. This also ends the "Ignoring inability to install 'opfs' sqlite3_vfs" warnings.
- `oo1.DB`'s SQL trace callback is installed the first time a database is opened with the `"t"` flag instead of unconditionally at init (a bundle-time rewrite of the glue; the build fails if the glue's code no longer matches).

APIs where SQLite calls back into JS (`create_function`, hooks, `trace_v2` / the `"t"` flag, JS VFSes, …) still can't work on iOS; the README lists them. Reads, writes, transactions, export and `sqlite3_deserialize` — everything `cross-sqlite-client`'s mini program adapter uses — need no callback. The tests now simulate both iOS behaviors; still not verified on an iOS device.
