import { useState } from "react"
import { useDbClient, useDbQuery } from "cross-sqlite-client/react"
import { appendLog } from "./log"

interface Note {
  id: number
  content: string
  created_at: string
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NotesPanel() {
  const client = useDbClient()
  // 新增、删除以后不用手动刷新：写入通知会让它在 transition 里重新查询，查完之前旧列表一直在
  const notes = useDbQuery(["notes"], (db) => db.select<Note>("SELECT id, content, created_at FROM notes ORDER BY id DESC"))
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>, failure: string) {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      appendLog("error", `${failure}：${errorDetail(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const addNote = () =>
    run(async () => {
      const content = draft.trim()
      if (!content) return
      const { lastInsertId } = await client.execute("INSERT INTO notes (content) VALUES (?)", [content])
      appendLog("info", `新增便签 #${lastInsertId ?? "?"}：${content}`)
      setDraft("")
    }, "新增便签失败")

  const removeNote = (id: number) =>
    run(async () => {
      const { rowsAffected } = await client.execute("DELETE FROM notes WHERE id = ?", [id])
      appendLog("info", `删除便签 #${id}（影响 ${rowsAffected ?? 0} 行）`)
    }, "删除便签失败")

  // 手写事务放进 groupWrites：十条写入只发一次写入通知，而且是在 COMMIT 之后，
  // 列表不会在提交之前重新查询、读到还没提交的数据
  const addTen = () =>
    run(
      () =>
        client.groupWrites(async () => {
          await client.execute("BEGIN")
          try {
            for (let i = 1; i <= 10; i++) await client.execute("INSERT INTO notes (content) VALUES (?)", [`批量便签 ${i}`])
            await client.execute("COMMIT")
          } catch (error) {
            await client.execute("ROLLBACK").catch(() => {})
            throw error
          }
          appendLog("info", "批量新增 10 条（一个事务，一次写入通知）")
        }),
      "批量新增失败",
    )

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">便签</h2>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void addNote()
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="写点什么…"
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-sm text-white hover:bg-sky-700 disabled:opacity-50"
        >
          添加
        </button>
        <button
          type="button"
          onClick={() => void addTen()}
          disabled={busy}
          className="rounded-md border border-sky-600 px-3 py-1.5 text-sm text-sky-700 hover:bg-sky-50 disabled:opacity-50"
        >
          批量 10 条
        </button>
      </form>
      <ul className="mt-4 space-y-2">
        {notes.length === 0 && <li className="text-sm text-slate-400">还没有便签，添加一条试试。</li>}
        {notes.map((note) => (
          <li key={note.id} className="flex items-start justify-between gap-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
            <div>
              <p className="text-sm">{note.content}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                #{note.id} · {note.created_at}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void removeNote(note.id)}
              disabled={busy}
              className="shrink-0 text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
