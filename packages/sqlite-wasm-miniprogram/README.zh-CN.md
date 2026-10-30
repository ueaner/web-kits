# sqlite-wasm-miniprogram

[English](./README.md)

把官方的 [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm) 构建成能在微信小程序里运行的版本：
通过 `WXWebAssembly` 得到和 Web 端完全一样的 `sqlite3` 对象（`oo1`、`capi`、`wasm`）和同一个 SQLite 版本。

持久化、迁移、写入通知请搭配 [`cross-sqlite-client`](../cross-sqlite-client) 的小程序适配器；这个包只负责让引擎跑起来。

| 本包  | `@sqlite.org/sqlite-wasm` | SQLite |
| ----- | ------------------------- | ------ |
| 0.2.x | 3.54.1-build1             | 3.54.1 |
| 0.1.x | 3.53.4-build1             | 3.53.4 |

具体版本也写在 `dist/assets/manifest.json` 里。

## 为什么要单独构建

官方 glue 不能原样在小程序里运行：

| 小程序的限制                                                                                                                               | 这份构建的处理                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 没有全局 `WebAssembly`，只有 `WXWebAssembly`；没有 `URL` / `URLSearchParams`；真机上也没有 `TextEncoder` / `TextDecoder`（开发者工具里有） | **打包时注入**垫片（esbuild 的 `inject`）：每个模块都被包了一层，运行时往全局挂的东西模块里看不到。文本编解码有原生实现就用原生的，没有时用纯 JS 的 UTF-8 实现 |
| `WXWebAssembly` 的实例来自另一个 realm：导出的函数过不了 `instanceof Function`，函数表抛的错误过不了 `instanceof TypeError`                | 导出函数改用本 realm 的 `Function.prototype`；函数表、内存抛的错误换成本 realm 的同类错误                                                                      |
| iOS 真机上 `WXWebAssembly` 导出的函数 `length` 都是 0，glue 却按 `length` 校验参数个数                                                     | 构建时从 `sqlite3.wasm` 读出每个导出的参数个数，`initSqlite3` 修正导出函数的 `length`（改不了的包一层转发）                                                    |
| `WXWebAssembly.instantiate` / `Module` **只接受包内的 `.wasm` / `.wasm.br` 路径**，不接受字节                                              | glue 给 JS 回调现场拼的小 wasm 模块，预先生成成 `stubs/<十六进制内容>.wasm`，运行时按内容找到对应文件                                                          |

## 安装

```bash
pnpm add sqlite-wasm-miniprogram
```

只提供 ESM 入口（`dist/index.js`）。Taro、vite-plugin-taro 等构建工具可以直接用；原生小程序项目需要一个打包步骤
（或开发者工具的「构建 npm」），把它转成小程序加载的代码。

把 `node_modules/sqlite-wasm-miniprogram/dist/assets/` 复制进小程序包，比如放在 `/sqlite`（里面有 `sqlite3.wasm`、`sqlite3.wasm.br`、
`stubs/` 和 `manifest.json`）。目录位置可以用 `dirname(require.resolve("sqlite-wasm-miniprogram/assets/manifest.json"))` 找到。例如：

- **原生小程序**：在构建步骤里复制到项目目录；
- **Taro**：`copy.patterns: [{ from: "node_modules/sqlite-wasm-miniprogram/dist/assets/", to: "dist/sqlite/" }]`；
- **vite-plugin-taro（VPT）**：复制到 `public/sqlite/`。

`sqlite3.wasm.br`（约 353 KB，默认）和 `sqlite3.wasm`（约 879 KB）只需要其中一个；JS 部分约 232 KB。放主包（2 MB 限制），
或者放在打开数据库之前就会加载的分包里。

## 用法

```ts
import { initSqlite3 } from "sqlite-wasm-miniprogram"

const sqlite3 = await initSqlite3({ webAssembly: WXWebAssembly, assetsDir: "/sqlite" })
const db = new sqlite3.oo1.DB(":memory:", "c")
```

搭配 `cross-sqlite-client`：

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

| 选项          | 默认值 | 说明                                                                |
| ------------- | ------ | ------------------------------------------------------------------- |
| `webAssembly` | —      | 小程序的 WebAssembly 运行时：全局的 `WXWebAssembly`。               |
| `assetsDir`   | —      | `dist/assets/` 复制到包内的位置，绝对路径（如 `/sqlite`）。         |
| `wasmFile`    | `"br"` | 加载 `sqlite3.wasm.br` 还是 `sqlite3.wasm`。                        |
| `logger`      | 无     | `{ warn }`，接收 glue 的诊断输出（例如"装不上 OPFS"，这是预期的）。 |

进程内只初始化一次，之后的调用返回同一个对象（参数以第一次为准）；初始化失败后，下一次调用会重试。

## 限制

- **iOS 真机上不能用 JS 回调**：iOS 的 `WXWebAssembly` 把 wasm 导出函数暴露成 JS 包装函数，wasm 函数表不收（`Table.set(): Argument 1 must be
  null or a WebAssembly function`），所以凡是要 SQLite 的 C 代码回调 JS 的 API 在 iOS 上都会抛错：`create_function` / `createFunction`、
  `create_collation`、`update_hook` / `commit_hook` 等钩子、`set_authorizer`、`progress_handler`、`trace_v2`（包括 `oo1.DB` 的 `"t"` 标志）、
  带 JS 回调的 `capi.sqlite3_exec`、JS 实现的 VFS 和虚拟表。JS 调 wasm 的路径不受影响：建表、读写、事务、`db.exec({ callback })`
  （它在 JS 里逐行 `step`）、导出和 `sqlite3_deserialize` 都能用。为此初始化时不装任何回调：JS 实现的 VFS（kvvfs 的 JS 方法、OPFS 系列）
  关掉了，`oo1.DB` 的 SQL trace 回调改成用 `"t"` 打开时才装（[web-kits#10](https://github.com/ueaner/web-kits/issues/10)）。
- **回调签名**（Android、开发者工具）：交给 SQLite 的 JS 函数需要它对应 wasm 签名的预生成桩模块。构建覆盖了
  glue 用到的回调、`cross-sqlite-client` 用到的能力，以及 glue 源码里能找到的全部签名字面量（共 13 个桩模块）。
  清单以外的签名会抛出 `missing prebuilt callback stub …`；要用回调类 API 之前，先看 `manifest.json` 里的 `stubs`。
- **只有内存数据库**：小程序里没有持久化的 VFS（默认 VFS 背后是 Emscripten 的内存文件系统，OPFS 要 Worker，kvvfs 要 localStorage），
  用 `:memory:` 打开。传 `wx.env.USER_DATA_PATH` 下的路径会报 `SQLITE_CANTOPEN`（result code 14），建了目录也只是内存里的文件。
  持久化靠快照：`sqlite3_js_db_export` 导出整个库写成文件，打开时读回来 `sqlite3_deserialize`（`cross-sqlite-client` 的适配器就是这样做的）。
- 已在微信开发者工具模拟器和 Android、iOS 真机（含微信云测试）上验证。

## 测试

```bash
pnpm build           # 打包、采集桩模块、生成 dist/assets
pnpm test            # Node：模拟的小程序环境（node:vm 提供另一个 realm、只接受路径的 Module）
pnpm test:devtools   # 微信开发者工具：生成 .devtools-probe/，用 miniprogram-automator 运行
```

`test:devtools` 需要已登录、并在「设置 → 安全设置」里打开了**服务端口**的微信开发者工具。环境变量：

- `WECHAT_DEVTOOLS_CLI`：开发者工具的命令行，默认 `cli`。Linux 上用社区版（msojocs/wechat-web-devtools-linux）时写成
  `"<安装目录>/bin/wechat-devtools-cli cli"`，因为这个 CLI 会吞掉第一个参数。要先把 AppImage 解压到固定目录：
  AppImage 每次运行都挂载到新位置，而开发者工具按安装路径计算数据目录。
- `WECHAT_APPID`：默认是测试号 `touristappid`。真机测试时设置成你的 AppID，运行 `pnpm test:devtools --preview qr.png`，用微信扫码。
  杀掉小程序再打开，页面上的 `previous-launches` 会显示上一次启动的记录，用来确认数据在重启后还在。

## 许可证

MIT。打包进来的 `@sqlite.org/sqlite-wasm` 是 Apache-2.0，SQLite 本身属于公有领域；见 `dist/THIRD_PARTY_NOTICES.md`。
