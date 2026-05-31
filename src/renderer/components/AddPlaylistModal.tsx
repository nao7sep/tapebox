import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnumEntry } from '@shared/ipc-contract'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { formatTime } from '@renderer/lib/format'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { Modal } from '@renderer/components/Modal'
import { IndeterminateBar } from '@renderer/components/Progress'
import { Button, INPUT_CLASS } from '@renderer/components/ui'

type Props = { onClose: () => void; initialUrl?: string }

/**
 * Add a playlist or channel. The user pastes/scans a URL, reviews the videos in
 * a checkable table, and adds the selected ones in bulk.
 *
 * The modal owns the enum session: it subscribes to enum:* once on mount and
 * filters events by the current sessionId (set when enum:start resolves), so a
 * re-scan cleanly supersedes the previous stream.
 */
export function AddPlaylistModal({ onClose, initialUrl = '' }: Props) {
  const { url, setUrl, onPaste } = useClipboardUrl(true, initialUrl)
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [entries, setEntries] = useState<EnumEntry[]>([])
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
        if (e.sessionId === sessionIdRef.current) { setScanning(false); setScanned(true) }
      }),
      ipcOn('enum:error', (e) => {
        if (e.sessionId === sessionIdRef.current) { setScanning(false); setScanned(true); setError(e.error) }
      }),
    ]
    return () => {
      offs.forEach((off) => off())
      const sid = sessionIdRef.current
      if (sid) void ipcInvoke('enum:cancel', { sessionId: sid }).catch(() => {})
    }
  }, [])

  function scan() {
    const v = url.trim()
    if (!v || scanning) return
    const prev = sessionIdRef.current
    if (prev) void ipcInvoke('enum:cancel', { sessionId: prev }).catch(() => {})
    sessionIdRef.current = null
    setEntries([])
    setSelected(new Set())
    setSearch('')
    setError(null)
    setScanned(false)
    setScanning(true)
    void ipcInvoke('enum:start', { url: v })
      .then((r) => { sessionIdRef.current = r.sessionId })
      .catch((err) => { setError(String(err)); setScanning(false); setScanned(true) })
  }

  async function stopScan() {
    const sid = sessionIdRef.current
    if (sid) await ipcInvoke('enum:cancel', { sessionId: sid }).catch(() => {})
    setScanning(false)
    setScanned(true)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => (e.title ?? '').toLowerCase().includes(q))
  }, [entries, search])

  function toggle(sourceUrl: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourceUrl)) next.delete(sourceUrl)
      else next.add(sourceUrl)
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

  async function confirm() {
    const urls = Array.from(selected)
    if (urls.length === 0) return
    setAdding(true)
    try {
      await ipcInvoke('downloads:addBulk', { urls })
      onClose()
    } finally {
      setAdding(false)
    }
  }

  const inBoxCount = entries.filter((e) => e.alreadyInLibrary).length
  const footer = (
    <>
      {inBoxCount > 0 && (
        <span className="mr-auto text-xs text-amber-400">{inBoxCount} already in box</span>
      )}
      <Button variant="ghost" onClick={onClose} disabled={adding}>Cancel</Button>
      <Button variant="primary" onClick={() => void confirm()} disabled={selected.size === 0 || adding}>
        {adding ? 'Adding…' : `Add ${selected.size} ${selected.size === 1 ? 'item' : 'items'}`}
      </Button>
    </>
  )

  return (
    <Modal title="Add playlist or channel" onClose={onClose} size="2xl" footer={footer}>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => { if (e.key === 'Enter') scan() }}
          placeholder="Paste a playlist or channel URL"
          spellCheck={false}
          className={`flex-1 ${INPUT_CLASS}`}
        />
        <Button
          variant={scanning ? 'secondary' : 'primary'}
          onClick={() => (scanning ? void stopScan() : scan())}
          disabled={!scanning && !url.trim()}
        >
          {scanning ? 'Stop' : 'Scan'}
        </Button>
      </div>

      {!scanning && !scanned ? (
        <p className="mt-3 text-center text-sm text-zinc-300">
          Paste a playlist or channel URL, then Scan.
        </p>
      ) : (
        <div className="mt-3 text-center">
          <div className="text-2xl font-semibold tabular-nums text-sky-300">{entries.length}</div>
          <div className="mt-0.5 text-xs text-zinc-300">
            {scanning ? 'scanning…' : entries.length === 1 ? 'video found' : 'videos found'}
          </div>
          {scanning && (
            <div className="mx-auto mt-2 max-w-[12rem]">
              <IndeterminateBar />
            </div>
          )}
          {error && <p className="mt-1.5 text-xs text-red-300">{error}</p>}
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => bulkSelect(true)}>Select all</Button>
            <Button variant="secondary" size="sm" onClick={() => bulkSelect(false)}>Clear</Button>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title…"
              className={`flex-1 ${INPUT_CLASS}`}
            />
          </div>

          <ul className="mt-2 max-h-[45vh] overflow-y-auto">
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
                    {e.alreadyInLibrary && <span className="shrink-0 text-xs text-amber-400">in box</span>}
                    <span className="min-w-0 flex-1 truncate">
                      {e.title ?? e.sourceUrl}
                      {e.unavailable && <span className="ml-2 text-xs text-zinc-300">({e.unavailable.reason})</span>}
                    </span>
                    <span className="text-xs tabular-nums text-zinc-300">
                      {e.durationSeconds != null ? formatTime(e.durationSeconds) : ''}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Modal>
  )
}
