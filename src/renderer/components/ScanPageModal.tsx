import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScanResult } from '@shared/ipc-contract'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { formatTime } from '@renderer/lib/format'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'
import { Modal } from '@renderer/components/Modal'
import { IndeterminateBar } from '@renderer/components/Progress'
import { Button, INPUT_CLASS } from '@renderer/components/ui'

type Props = { onClose: () => void; initialUrl?: string }

/**
 * Scan a page for videos — a URL that lists multiple videos (a creator's uploads,
 * search results, a category). The user pastes a page URL, scans it, reviews the
 * videos in a checkable table, and adds the selected ones in bulk.
 *
 * The modal owns the scan session: it subscribes to scan:* once on mount and
 * filters events by the current sessionId (set when scan:start resolves), so a
 * re-scan cleanly supersedes the previous stream.
 */
export function ScanPageModal({ onClose, initialUrl = '' }: Props) {
  const { url, setUrl, onPaste } = useClipboardUrl(true, initialUrl)
  const { composingRef, handlers: composing } = useComposing()
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [entries, setEntries] = useState<ScanResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)

  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    const offs = [
      ipcOn('scan:entry', (e) => {
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
      ipcOn('scan:done', (e) => {
        if (e.sessionId === sessionIdRef.current) { setScanning(false); setScanned(true) }
      }),
      ipcOn('scan:error', (e) => {
        if (e.sessionId === sessionIdRef.current) { setScanning(false); setScanned(true); setError(e.error) }
      }),
    ]
    return () => {
      offs.forEach((off) => off())
      const sid = sessionIdRef.current
      if (sid) void ipcInvoke('scan:cancel', { sessionId: sid }).catch((err) => log.debug('scan cancel failed', { error: describeError(err) }))
    }
  }, [])

  function scan() {
    const v = url.trim()
    if (!v || scanning) return
    const prev = sessionIdRef.current
    if (prev) void ipcInvoke('scan:cancel', { sessionId: prev }).catch((err) => log.debug('scan cancel failed', { error: describeError(err) }))
    sessionIdRef.current = null
    setEntries([])
    setSelected(new Set())
    setSearch('')
    setError(null)
    setScanned(false)
    setScanning(true)
    void ipcInvoke('scan:start', { url: v })
      .then((r) => { sessionIdRef.current = r.sessionId })
      .catch((err) => { setError(String(err)); setScanning(false); setScanned(true) })
  }

  async function stopScan() {
    const sid = sessionIdRef.current
    if (sid) await ipcInvoke('scan:cancel', { sessionId: sid }).catch((err) => log.debug('scan cancel failed', { error: describeError(err) }))
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

  const inLibraryCount = entries.filter((e) => e.alreadyInLibrary).length
  const footer = (
    <>
      {inLibraryCount > 0 && (
        <span className="mr-auto text-xs text-zinc-400">{inLibraryCount} already in your library</span>
      )}
      <Button variant="ghost" onClick={onClose} disabled={adding}>Cancel</Button>
      <Button variant="primary" onClick={() => void confirm()} disabled={selected.size === 0} loading={adding}>
        {adding ? 'Adding…' : `Add ${selected.size} ${selected.size === 1 ? 'tape' : 'tapes'}`}
      </Button>
    </>
  )

  return (
    <Modal title="Scan a page" onClose={onClose} size="2xl" footer={footer}>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          onCompositionStart={composing.onCompositionStart}
          onCompositionEnd={composing.onCompositionEnd}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposingKeyboardEvent(composingRef, e)) scan() }}
          placeholder="Paste a page URL"
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
          Paste the URL of a page that lists videos — a creator's uploads, search results, a category.
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
                    {e.alreadyInLibrary && <span className="shrink-0 text-xs text-zinc-400">In library</span>}
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
