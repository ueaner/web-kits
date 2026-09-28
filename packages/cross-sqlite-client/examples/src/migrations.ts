import type { Migration } from "cross-sqlite-client"

// 迁移语句必须幂等（可安全重复执行），CREATE 一律带 IF NOT EXISTS；
// 不要用 ALTER TABLE ... ADD COLUMN——SQLite 不支持 ADD COLUMN IF NOT EXISTS
export const migrations: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at)",
      "CREATE TABLE IF NOT EXISTS note_meta (key TEXT PRIMARY KEY, value TEXT)",
    ],
  },
]
