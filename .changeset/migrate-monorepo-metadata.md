---
"cross-tab-kit": patch
"pending-task-kit": patch
"cross-sqlite-client": patch
---

monorepo 迁移元数据变更（无 API/行为变化）：
- `repository` / `homepage` / `bugs` 指向新的 monorepo `ueaner/web-kits`，`repository.directory` 指向 `packages/<pkg>`
- 共享开发依赖（`@changesets/cli`、`oxfmt`、`oxlint`、`publint`、`typescript`）上提到根
- `pending-task-kit` 的 `cross-tab-kit` 依赖由 `"0.4.0"` 改为 `"workspace:*"`，发布 tarball 中仍是精确 `"0.4.0"`（pnpm pack 行为，§1.3 实测）
- `cross-sqlite-client` 新增 `publishConfig: { access: "public" }` 与 `main` / `module` / `types`（指向 `dist/core/index.{js,d.ts}`，对齐其它两包）
- `pending-task-kit` 新增 `publishConfig: { access: "public" }`（对齐 drift #4）

详细方案见 `docs/migrations/monorepo-迁移方案.md`。
