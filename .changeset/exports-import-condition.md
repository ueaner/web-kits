---
"cross-tab-kit": patch
"pending-task-kit": patch
---

`exports` 中的运行时分支配 `"default"` 改为 `"import"`（仅 CTK、PTK；CSC 原本就是 `"import"`，无需改动）。

行为差异：

- **ESM 消费者（Node ESM、bundler、Vitest）：完全不变**。Node 在 ESM 路径下会优先匹配 `"import"` 条件；之前 `"default"` 作为唯一条件时也是被这条路径命中，所以运行时行为一致。
- **CJS 消费者：现在会显式失败**（`ERR_PACKAGE_PATH_NOT_EXPORTED`），而不是含糊地拿到 ESM 文件后被 Node 22.12+ 的 `require(esm)` 静默加载。这与三个包 `"type": "module"` 的 ESM-only 立场一致。

API 与类型没有任何变化。`publint` 三包全绿。
