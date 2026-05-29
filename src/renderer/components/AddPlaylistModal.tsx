import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnumEntry } from '@shared/ipc-contract'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { formatTime } from '@renderer/lib/format'
import { Button } from '@renderer/components/ui'

type Props = {
  url: string
  sourceTitle: string | null
  onClose: () => void
}

/**
 * Playlist / channel adder.
 *
 * The modal owns the enum:start lifecycle. The flow:
 *   1. useEffect runs once on mount.
 *   2. Subscriptions for enum:entry / enum:done / enum:error are attached
 *      FIRST. They use a sessionId ref to filter events; the ref starts null
 *      and is populated when enum:start returns.
 *   3. Only after subscriptions are wired does the modal call enum:start.
 *
 * Result: there is no window in which main can emit events before the
 * renderer is listening, even if the renderer's event loop is busy.
 */
export function AddPlaylistModal({ url, sourceTitle, onClose }: Props) {
  const [entries, setEntries] = useState<EnumEntry[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)

  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    const offs = [
      ipcOn('enum:entry', (e) => {
        if (e.sessionId !== sessionIdRef.current) return
        setEntries((prev) => [...prev, e.entry])
        if (!e.entry.alreadyInLibrary && !e.entry.unavailable) {
          setSelected((prev) => {
            const next = new Set(prev)
            next.add(e.entry.sourceUrl)
            return next
          })
        }
      }),
      ipcOn('enum:done', (e) => {
        if (e.sessionId === sessionIdRef.current) setDone(true)
      }),
      ipcOn('enum:error', (e) => {
        if (e.sessionId === sessionIdRef.current) { setDone(true); setError(e.error) }
      }),
    ]

    // Subscriptions are now live. Safe to start streaming.
    ipcInvoke('enum:start', { url })
      .then((r) => { sessionIdRef.current = r.sessionId })
      .catch((err) => { setError(String(err)); setDone(true) })

    return () => {
      offs.forEach((off) => off())
      // Best-effort cancel on unmount. If the modal closes via Cancel button
      // we've already called enum:cancel; this is a safety net for other
      // unmount paths (programmatic close, page navigation in dev mode, etc.).
      const sid = sessionIdRef.current
      if (sid) void ipcInvoke('enum:cancel', { sessionId: sid }).catch(() => {})
    }
  }, [url])

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
    const sid = sessionIdRef.current
    if (sid) await ipcInvoke('enum:cancel', { sessionId: sid }).catch(() => {})
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
    const sid = sessionIdRef.current
    if (sid && !done) await ipcInvoke('enum:cancel', { sessionId: sid }).catch(() => {})
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        <header className="shrink-0 border-b border-zinc-800 p-4">
          <h2 className="text-base font-medium">
            Add from {sourceTitle ? <span className="text-zinc-200">{sourceTitle}</span> : 'playlist'}
          </h2>
          <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
            {!done ? (
              <>
                <span>Loading {entries.length}…</span>
                <Button variant="ghost" size="sm" onClick={stopLoading}>Stop loading</Button>
              </>
            ) : (
              <span>{entries.length} items</span>
            )}
            {error && <span className="text-red-400">· {error}</span>}
          </div>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 p-3">
          <Button variant="secondary" size="sm" onClick={() => bulkSelect(true)}>Select all</Button>
          <Button variant="secondary" size="sm" onClick={() => bulkSelect(false)}>Clear</Button>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title…"
            className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs placeholder-zinc-600 focus:border-zinc-600 focus:outline-hidden"
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
                    'flex items-center gap-3 rounded px-2 py-1.5 text-sm ' +
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
                      <span className="ml-2 text-xs text-zinc-400">(in box)</span>
                    )}
                    {e.unavailable && (
                      <span className="ml-2 text-xs text-zinc-400">({e.unavailable.reason})</span>
                    )}
                  </span>
                  <span className="text-xs tabular-nums text-zinc-400">
                    {e.durationSeconds != null ? formatTime(e.durationSeconds) : ''}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>

        <footer className="flex shrink-0 items-center justify-between border-t border-zinc-800 p-4">
          <span className="text-xs text-zinc-400">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button variant="primary" onClick={confirm} disabled={selected.size === 0 || adding}>
              {adding ? 'Adding…' : `Add ${selected.size} ${selected.size === 1 ? 'item' : 'items'}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}
