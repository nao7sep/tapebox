import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ScanResult } from '@shared/ipc-contract'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { presentFailure } from '@renderer/lib/presentFailure'
import { formatTime } from '@renderer/lib/format'
import { visibleRowRange } from '@renderer/lib/windowedRows'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'
import { Modal } from '@renderer/components/Modal'
import { IndeterminateBar } from '@renderer/components/Progress'
import { Button, InlineError, INPUT_LINE_CLASS } from '@renderer/components/ui'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'

type Props = { onClose: () => void; initialUrl?: string }

/** Fixed row height (px) of the results list, which renders only visible rows. */
const ROW_HEIGHT = 32

/**
 * Scan a page for videos — a URL that lists multiple videos (a creator's uploads,
 * search results, a category). The user pastes a page URL, scans it, reviews the
 * videos in a checkable table, and adds the selected ones in bulk.
 *
 * The modal owns the scan session: it subscribes to scan:* once on mount and
 * filters events by the current sessionId (set when scan:start resolves), so a
 * re-scan cleanly supersedes the previous stream.
 *
 * A scan can stream thousands of entries, so arrivals are deduplicated through a
 * Set, buffered, and committed to state once per animation frame, and the list
 * renders only the rows in view.
 */
export function ScanPageModal({ onClose, initialUrl = '' }: Props) {
  const { url, setUrl, onPaste } = useClipboardUrl(true, initialUrl)
  const { composingRef, handlers: composing } = useComposing()
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [entries, setEntries] = useState<ScanResult[]>([])
  const [error, setError] = useState<Message | null>(null)
  const t = useI18n()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)

  const sessionIdRef = useRef<string | null>(null)
  // Arrivals not yet committed to state, the sourceUrls already seen this scan,
  // and the pending frame that will commit them.
  const pendingRef = useRef<ScanResult[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const frameRef = useRef<number | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  function flushPending() {
    frameRef.current = null
    const batch = pendingRef.current
    if (batch.length === 0) return
    pendingRef.current = []
    setEntries((prev) => prev.concat(batch))
    const selectable = batch.filter((entry) => !entry.alreadyInLibrary && !entry.unavailable)
    if (selectable.length > 0) {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const entry of selectable) next.add(entry.sourceUrl)
        return next
      })
    }
  }

  function resetPending() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    pendingRef.current = []
    seenRef.current = new Set()
  }

  useEffect(() => {
    const offs = [
      ipcOn('scan:entry', (e) => {
        if (e.sessionId !== sessionIdRef.current) return
        // The same video can surface twice on a listing page; dedup by sourceUrl so the
        // list keys and the (sourceUrl-keyed) selection stay unambiguous.
        if (seenRef.current.has(e.entry.sourceUrl)) return
        seenRef.current.add(e.entry.sourceUrl)
        pendingRef.current.push(e.entry)
        frameRef.current ??= requestAnimationFrame(flushPending)
      }),
      ipcOn('scan:done', (e) => {
        if (e.sessionId === sessionIdRef.current) { setScanning(false); setScanned(true) }
      }),
      ipcOn('scan:error', (e) => {
        if (e.sessionId === sessionIdRef.current) {
          setScanning(false)
          setScanned(true)
          setError(message('scan.failed'))
        }
      }),
    ]
    return () => {
      offs.forEach((off) => off())
      resetPending()
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
    resetPending()
    setEntries([])
    setSelected(new Set())
    setSearch('')
    setError(null)
    setScanned(false)
    setScanning(true)
    void ipcInvoke('scan:start', { url: v })
      .then((r) => { sessionIdRef.current = r.sessionId })
      .catch((err) => { setError(presentFailure(err, message('scan.failed'), 'page scan start failed')); setScanning(false); setScanned(true) })
  }

  async function stopScan() {
    const sid = sessionIdRef.current
    if (!sid) return
    try {
      await ipcInvoke('scan:cancel', { sessionId: sid })
      // The stopped session is over: a late event from its exiting process is ignored.
      if (sessionIdRef.current === sid) sessionIdRef.current = null
      setScanning(false)
      setScanned(true)
    } catch (err) {
      setError(presentFailure(
        err,
        message('scan.stopFailed'),
        'page scan cancellation failed',
      ))
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => (e.title ?? '').toLowerCase().includes(q))
  }, [entries, search])

  // The list grows up to its max height as rows arrive; re-measure when the row
  // count changes (scrolling measures too).
  useLayoutEffect(() => {
    if (listRef.current) setViewportHeight(listRef.current.clientHeight)
  }, [filtered.length])

  const range = visibleRowRange(scrollTop, viewportHeight, ROW_HEIGHT, filtered.length)
  const visibleRows = filtered.slice(range.start, range.end)

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
    setError(null)
    try {
      await ipcInvoke('downloads:addBulk', { urls })
      onClose()
    } catch (err) {
      setError(presentFailure(err, message('scan.addFailed'), 'bulk tape add failed'))
    } finally {
      setAdding(false)
    }
  }

  const inLibraryCount = useMemo(() => entries.filter((e) => e.alreadyInLibrary).length, [entries])
  const footer = (
    <>
      {inLibraryCount > 0 && (
        <span className="mr-auto text-xs text-fg-muted">{t.t('scan.inLibraryCount', { count: inLibraryCount })}</span>
      )}
      <Button variant="ghost" onClick={onClose} disabled={adding}>{t.t('common.cancel')}</Button>
      <Button variant="primary" onClick={() => void confirm()} disabled={selected.size === 0} loading={adding}>
        {adding ? t.t('scan.adding') : t.t('scan.addTapes', { count: selected.size })}
      </Button>
    </>
  )

  return (
    <Modal title={t.t('scan.title')} onClose={onClose} size="2xl" footer={footer}>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          onCompositionStart={composing.onCompositionStart}
          onCompositionEnd={composing.onCompositionEnd}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposingKeyboardEvent(composingRef, e)) scan() }}
          placeholder={t.t('scan.placeholder')}
          spellCheck={false}
          className={`flex-1 ${INPUT_LINE_CLASS}`}
        />
        <Button
          variant={scanning ? 'secondary' : 'primary'}
          onClick={() => (scanning ? void stopScan() : scan())}
          disabled={!scanning && !url.trim()}
        >
          {t.t(scanning ? 'common.stop' : 'scan.scan')}
        </Button>
      </div>

      {!scanning && !scanned ? (
        <p className="mt-3 text-center text-sm text-fg">
          {t.t('scan.intro')}
        </p>
      ) : (
        <div className="mt-3 text-center">
          <div className="text-2xl font-semibold tabular-nums text-info-fg">{entries.length}</div>
          <div className="mt-0.5 text-xs text-fg">
            {scanning ? t.t('scan.scanning') : t.t('scan.videosFound', { count: entries.length })}
          </div>
          {scanning && (
            <div className="mx-auto mt-2 max-w-[12rem]">
              <IndeterminateBar />
            </div>
          )}
          {error && <InlineError className="mt-1.5 text-left">{t.text(error)}</InlineError>}
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => bulkSelect(true)}>{t.t('scan.selectAll')}</Button>
            <Button variant="secondary" size="sm" onClick={() => bulkSelect(false)}>{t.t('scan.clearSelection')}</Button>
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setScrollTop(0)
                if (listRef.current) listRef.current.scrollTop = 0
              }}
              placeholder={t.t('scan.searchPlaceholder')}
              className={`flex-1 ${INPUT_LINE_CLASS}`}
            />
          </div>

          <ul
            ref={listRef}
            className="mt-2 max-h-[45vh] overflow-y-auto"
            onScroll={(event) => {
              setScrollTop(event.currentTarget.scrollTop)
              setViewportHeight(event.currentTarget.clientHeight)
            }}
            style={{
              paddingTop: range.start * ROW_HEIGHT,
              paddingBottom: (filtered.length - range.end) * ROW_HEIGHT,
            }}
          >
            {visibleRows.map((e) => {
              const disabled = e.alreadyInLibrary || e.unavailable !== null
              const checked = selected.has(e.sourceUrl) && !disabled
              return (
                <li key={e.sourceUrl} style={{ height: ROW_HEIGHT }}>
                  <label
                    className={
                      'flex h-full items-center gap-3 rounded px-2 text-sm ' +
                      (disabled ? 'opacity-50' : 'hover:bg-hover')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(e.sourceUrl)}
                      disabled={disabled}
                    />
                    {e.alreadyInLibrary && <span className="shrink-0 text-xs text-fg-muted">{t.t('tapeState.downloaded')}</span>}
                    <span className="min-w-0 flex-1 truncate">
                      {e.title ?? e.sourceUrl}
                      {e.unavailable && <span className="ml-2 text-xs text-fg">({e.unavailable.reason})</span>}
                    </span>
                    <span className="text-xs tabular-nums text-fg">
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
