import { useCallback, useEffect, useState } from "react"
import { useDatabase } from "cross-sqlite-client/react"
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
  const { dbClient, isDbReady } = useDatabase()
  const [notes, setNotes] = useState<Note[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!dbClient) return
    const rows = await dbClient.select<Note>("SELECT id, content, created_at FROM notes ORDER BY id DESC")
    setNotes(rows)
  }, [dbClient])

  useEffect(() => {
    if (!isDbReady) {
      setNotes([])
      return
    }
    refresh().catch((error: unknown) => appendLog("error", `加载便签列表失败：${errorDetail(error)}`))
  }, [isDbReady, refresh])

  async function addNote() {
    const content = draft.trim()
    if (!dbClient || !content || busy) return
    setBusy(true)
    try {
      const { lastInsertId } = await dbClient.execute("INSERT INTO notes (content) VALUES (?)", [content])
      appendLog("info", `新增便签 #${lastInsertId ?? "?"}：${content}`)
      setDraft("")
      await refresh()
    } catch (error) {
      appendLog("error", `新增便签失败：${errorDetail(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function removeNote(id: number) {
    if (!dbClient || busy) return
    setBusy(true)
    try {
      const { rowsAffected } = await dbClient.execute("DELETE FROM notes WHERE id = ?", [id])
      appendLog("info", `删除便签 #${id}（影响 ${rowsAffected ?? 0} 行）`)
      await refresh()
    } catch (error) {
      appendLog("error", `删除便签失败：${errorDetail(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!isDbReady) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">便签</h2>
        <p className="mt-3 text-sm text-slate-500">数据库未就绪，便签功能暂不可用。</p>
      </section>
    )
  }

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
