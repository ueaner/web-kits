---
"cross-sqlite-client": patch
---

可选依赖 `@tauri-apps/plugin-sql` 的版本范围从 `^2.5.0` 提升到 `^2.6.0`。2.6.0 只给 `Database.load` 新增了可选的 `options`（`autoCreate`），本包的用法无变化；仍锁在 2.5.x 的 Tauri 项目升级本包时，会被连带升级到 2.6.x。
