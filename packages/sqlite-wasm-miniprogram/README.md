# sqlite-wasm-miniprogram

[简体中文](./README.zh-CN.md)

The official [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm), built to run in
WeChat mini programs. It gives you the same `sqlite3` object (`oo1`, `capi`, `wasm`) and the same SQLite version as
on the web, through `WXWebAssembly`.

Pair it with [`cross-sqlite-client`](../cross-sqlite-client)'s mini program adapter for persistence, migrations
and write notifications; this package only makes the engine run.

| This package | `@sqlite.org/sqlite-wasm` | SQLite |
| ------------ | ------------------------- | ------ |
| 0.1.x        | 3.53.4-build1             | 3.53.4 |

The exact versions are also in `dist/assets/manifest.json`.

## Why a separate build

The official glue can't run in a mini program as is:

| Mini program constraint                                                                                                                             | What this build does                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No global `WebAssembly`, only `WXWebAssembly`; no `URL` / `URLSearchParams`; on devices no `TextEncoder` / `TextDecoder` either (DevTools has them) | Shims injected **at bundle time** (esbuild `inject`): each module is wrapped, so globals assigned at runtime aren't visible. The text codecs use the native ones when present, a pure-JS UTF-8 implementation otherwise |
| `WXWebAssembly` instances come from another realm: exported functions fail `instanceof Function`, table errors fail `instanceof TypeError`          | Exported functions get this realm's `Function.prototype`; table/memory errors are re-thrown as this realm's types                                                                                                       |
| On iOS devices, `WXWebAssembly`'s exported functions report `length === 0`, while the glue checks `length` against each function's parameter count  | The build reads every export's parameter count from `sqlite3.wasm`; `initSqlite3` restores `length` on the exports (a forwarding wrapper where it can't be redefined)                                                   |
| `WXWebAssembly.instantiate` / `Module` only accept a `.wasm` / `.wasm.br` **path inside the package**, never bytes                                  | The glue builds tiny per-signature wasm modules for JS callbacks; they're prebuilt into `stubs/<hex>.wasm` and looked up by content                                                                                     |

## Install

```bash
pnpm add sqlite-wasm-miniprogram
```

The package is ESM only (`dist/index.js`). Taro, vite-plugin-taro and other bundlers consume it as is; a native
mini program project needs a bundling step (or the DevTools npm build) that turns it into what the mini program loads.

Copy `node_modules/sqlite-wasm-miniprogram/dist/assets/` into your mini program package, e.g. as `/sqlite`
(it holds `sqlite3.wasm`, `sqlite3.wasm.br`, `stubs/` and `manifest.json`). Find the directory with
`dirname(require.resolve("sqlite-wasm-miniprogram/assets/manifest.json"))`. For example:

- **Native**: copy it into the project directory in a build step.
- **Taro**: `copy.patterns: [{ from: "node_modules/sqlite-wasm-miniprogram/dist/assets/", to: "dist/sqlite/" }]`.
- **vite-plugin-taro (VPT)**: copy it into `public/sqlite/`.

Only one of `sqlite3.wasm.br` (≈ 341 KB, the default) and `sqlite3.wasm` (≈ 869 KB) is needed; the JS bundle adds
≈ 220 KB. Put them in the main package (2 MB limit) or a subpackage that is loaded before the database opens.

## Usage

```ts
import { initSqlite3 } from "sqlite-wasm-miniprogram"

const sqlite3 = await initSqlite3({ webAssembly: WXWebAssembly, assetsDir: "/sqlite" })
const db = new sqlite3.oo1.DB(":memory:", "c")
```

With `cross-sqlite-client`:

```ts
import { createDbClient, transactionalExecutor } from "cross-sqlite-client"
import { createMiniProgramAdapter } from "cross-sqlite-client/adapters/miniprogram"
import { initSqlite3 } from "sqlite-wasm-miniprogram"

const adapter = createMiniProgramAdapter({
  sqlite3: () => initSqlite3({ webAssembly: WXWebAssembly, assetsDir: "/sqlite" }),
  fs: wx.getFileSystemManager(),
  directory: `${wx.env.USER_DATA_PATH}/cross-sqlite-client`,
})
const client = await createDbClient({ name: "app", adapter, migrations, migrationOptions: { executor: transactionalExecutor } })
```

### `initSqlite3(options)`

| Option        | Default | Meaning                                                                                   |
| ------------- | ------- | ----------------------------------------------------------------------------------------- |
| `webAssembly` | —       | The mini program's WebAssembly runtime: the global `WXWebAssembly`.                       |
| `assetsDir`   | —       | Where `dist/assets/` was copied inside the package, as an absolute path (e.g. `/sqlite`). |
| `wasmFile`    | `"br"`  | Load `sqlite3.wasm.br` or `sqlite3.wasm`.                                                 |
| `logger`      | none    | `{ warn }` for the glue's diagnostics (e.g. "can't install OPFS", which is expected).     |

The engine is initialized once per process; later calls return the same object (options from the first call).
If initialization fails, the next call tries again.

## Limitations

- **Callback signatures.** A JS function handed to SQLite (VFS methods, `create_function`, `update_hook`, …) needs a
  prebuilt stub for its wasm signature. The build covers everything the glue sets up at init, what
  `cross-sqlite-client` uses, and every signature literal found in the glue's source (13 stubs). A signature outside
  that set throws `missing prebuilt callback stub …`; check `stubs` in `manifest.json` before relying on callback APIs.
- **No OPFS / Worker APIs**: there's no persistent VFS in a mini program. Persist by exporting the database
  (that's what `cross-sqlite-client`'s adapter does).
- Verified in the WeChat DevTools simulator and on an Android device (Android 14, WeChat 8.0.79, base library 3.17.4): opening, writing, and reading back after re-entering the mini game. **Not yet verified on iOS devices** (the `length === 0` behavior of iOS is covered by a simulated runtime in the tests).

## Testing

```bash
pnpm build           # bundle, collect stubs, write dist/assets
pnpm test            # Node: a simulated mini program (another realm via node:vm, path-only Module)
pnpm test:devtools   # WeChat DevTools: generates .devtools-probe/, runs it with miniprogram-automator
```

`test:devtools` needs a logged-in WeChat DevTools with **Settings → Security → Service port** turned on. Environment:

- `WECHAT_DEVTOOLS_CLI` — the DevTools CLI (default `cli`). On Linux with the community build
  (msojocs/wechat-web-devtools-linux) use `"<install>/bin/wechat-devtools-cli cli"`: that CLI drops its first argument.
  Extract the AppImage to a fixed directory first; an AppImage mounts somewhere new on every run, and DevTools derives
  its data directory from the install path.
- `WECHAT_APPID` — defaults to the test AppID `touristappid`. For a real device, set your AppID and run
  `pnpm test:devtools --preview qr.png`, then scan the QR code. Kill and reopen the mini program to check that data
  survives a restart (`previous-launches` on the page).

## License

MIT. The bundled `@sqlite.org/sqlite-wasm` is Apache-2.0 and SQLite itself is public domain; see `dist/THIRD_PARTY_NOTICES.md`.
