import { useEffect, useMemo, useState } from 'react'
import type { EnumEntry } from '@shared/ipc-contract'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { formatTime } from '@renderer/lib/format'

type Props = {
  sessionId: string
  sourceTitle: string | null
  onClose: () => void
}

/**
 * Modal for playlist/channel adds.
 *   - Loads entries via the streaming enum:entry events.
 *   - All checkable entries are selected by default.
 *   - User can stop loading early; whatever loaded so far remains selectable.
 *   - Confirm adds the selected URLs via downloads:addBulk.
 */
export function AddPlaylistModal({ sessionId, sourceTitle, onClose }: Props) {
  const [entries, setEntries] = useState<EnumEntry[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const offs = [
      ipcOn('enum:entry', (e) => {
        if (e.sessionId !== sessionId) return
        setEntries((prev) => [...prev, e.entry])
        if (!e.entry.alreadyInLibrary && !e.entry.unavailable) {
          setSelected((prev) => {
            const next = new Set(prev)
            next.add(e.entry.sourceUrl)
            return next
          })
        }
      }),
      ipcOn('enum:done',  (e) => { if (e.sessionId === sessionId) setDone(true) }),
      ipcOn('enum:error', (e) => { if (e.sessionId === sessionId) { setDone(true); setError(e.error) } }),
    ]
    return () => offs.forEach((off) => off())
  }, [sessionId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => (e.title ?? '').toLowerCase().includes(q))
  }, [entries, search])

  function toggle(url: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  function bulkSelect(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const e of filtered) {
        if (e.alreadyInLibrary || e.unavailable) continue
        if (on) next.add(e.sourceUrl)
        else next.delete(e.sourceUrl)
      }
      return next
    })
  }

  async function stopLoading() {
    await ipcInvoke('enum:cancel', { sessionId }).catch(() => {})
    setDone(true)
  }

  async function confirm() {
    const urls = Array.from(selected)
    if (urls.length === 0) {
      onClose()
      return
    }
    setAdding(true)
    try {
      await ipcInvoke('downloads:addBulk', { urls })
      onClose()
    } finally {
      setAdding(false)
    }
  }

  async function cancel() {
    if (!done) await ipcInvoke('enum:cancel', { sessionId }).catch(() => {})
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        <header className="shrink-0 border-b border-zinc-800 p-4">
          <h2 className="text-base font-medium">
            Add from {sourceTitle ? <span className="text-zinc-200">{sourceTitle}</span> : 'playlist'}
          </h2>
          <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
            {!done ? (
              <>
                <span>Loading {entries.length}…</span>
                <button onClick={stopLoading} className="text-zinc-300 hover:text-zinc-100">
                  Stop loading
                </button>
              </>
            ) : (
              <span>{entries.length} items</span>
            )}
            {error && <span className="text-red-400">· {error}</span>}
          </div>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 p-3">
          <button
            onClick={() => bulkSelect(true)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Select all
          </button>
          <button
            onClick={() => bulkSelect(false)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Clear
          </button>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title…"
            className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        </div>

        <ul className="flex-1 overflow-y-auto p-2">
          {filtered.map((e) => {
            const disabled = e.alreadyInLibrary || e.unavailable !== null
            const checked = selected.has(e.sourceUrl) && !disabled
            return (
              <li key={e.sourceUrl}>
                <label
                  className={
                    'flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm ' +
                    (disabled ? 'opacity-50' : 'hover:bg-zinc-800/60')
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(e.sourceUrl)}
                    disabled={disabled}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {e.title ?? e.sourceUrl}
                    {e.alreadyInLibrary && (
                      <span className="ml-2 text-xs text-zinc-500">(in box)</span>
                    )}
                    {e.unavailable && (
                      <span className="ml-2 text-xs text-zinc-500">({e.unavailable.reason})</span>
                    )}
                  </span>
                  <span className="text-xs tabular-nums text-zinc-500">
                    {e.durationSeconds != null ? formatTime(e.durationSeconds) : ''}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>

        <footer className="flex shrink-0 items-center justify-between border-t border-zinc-800 p-4">
          <span className="text-xs text-zinc-500">{selected.size} selected</span>
          <div className="flex gap-2">
            <button
              onClick={cancel}
              className="rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={selected.size === 0 || adding}
              className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {adding ? 'Adding…' : `Add ${selected.size} ${selected.size === 1 ? 'item' : 'items'}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
