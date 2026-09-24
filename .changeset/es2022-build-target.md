---
"pending-task-kit": minor
"cross-tab-kit": patch
"cross-sqlite-client": patch
---

构建目标统一为 ES2022（`tsconfig.base.json` 的 `target`/`lib`，并显式声明
`useDefineForClassFields: true`，避免将来下调 `target` 时类字段语义被静默改变）。

对三个包的影响并不相同：

- **`cross-tab-kit` / `cross-sqlite-client`：发布产物逐字节不变**，仅构建配置变化。
- **`pending-task-kit`：`dist` 有实际变化**。ES2022 下 TS/oxc 直接输出**原生 class field**
  （`PendingTaskPoller` 的字段声明），并把这些字段上的 doc 注释作为普通注释保留下来：
  `dist` 体积从 27.10 kB 增至 29.45 kB。因此发布包的**最低 JS 引擎要求随之抬到 ES2022**
  （原生 class fields ≈ Chrome 74+ / Safari 14.1+ / Firefox 69+）。

API 与运行时行为没有任何变化，但浏览器兼容基线变了，所以 `pending-task-kit` 记 `minor`。
如果你的目标浏览器低于上面的基线、且构建流程不会对 `node_modules` 里的依赖做降级，
请在打包阶段自行降级该依赖（或在 issue 里说明，我们可以为它单独设一个更低的 `target`）。
