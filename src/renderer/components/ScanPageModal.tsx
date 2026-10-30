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

type ScanSubmission = {
  sessionId: string | null
  retired: boolean
  running: boolean
  stopRequested: boolean
  stopFailure: Message | null
  cancellation: Promise<void> | null
}

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

  const liveRef = useRef(true)
  const scanRef = useRef<ScanSubmission | null>(null)
  // Arrivals not yet committed to state, the sourceUrls already seen this scan,
  // and the pending frame that will commit them.
  const pendingRef = useRef<ScanResult[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const frameRef = useRef<number | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  // Rows have one fixed height for virtualization, so a long title is cut short
  // there; the row last focused or tapped shows its complete title and reason
  // beneath the list (responsive-interface-conventions).
  const [activeUrl, setActiveUrl] = useState<string | null>(null)

  function flushPending() {
    frameRef.current = null
    if (!liveRef.current) return
    const batch = pendingRef.current
    if (batch.length === 0) return
    pendingRef.current = []
    setEntries((prev) => prev.concat(batch))
    const selectable = batch.filter((entry) => !entry.alreadyInCollection && !entry.unavailable)
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

  function ownsSubmission(submission: ScanSubmission): boolean {
    return liveRef.current && !submission.retired && scanRef.current === submission
  }

  function cancelSubmission(submission: ScanSubmission): Promise<void> {
    // Stop and dismissal can overlap. One request owns cancellation of this exact
    // session until the bridge settles; main owns the process through its exit.
    if (submission.cancellation) return submission.cancellation
    const sessionId = submission.sessionId
    if (!sessionId) return Promise.resolve()
    const cancellation = ipcInvoke('scan:cancel', { sessionId })
      .then(() => {
        submission.sessionId = null
        submission.running = false
        if (!ownsSubmission(submission)) return
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
        flushPending()
        const previousFailure = submission.stopFailure
        submission.stopFailure = null
        if (previousFailure) setError((current) => current === previousFailure ? null : current)
        setScanning(false)
        setScanned(true)
      })
      .catch((err) => {
        if (ownsSubmission(submission)) {
          submission.stopRequested = false
          submission.stopFailure = presentFailure(err, message('scan.stopFailed'), 'page scan cancellation failed')
          setError(submission.stopFailure)
        } else {
          log.warn('page scan cancellation failed after dismissal', { sessionId, error: describeError(err) })
        }
      })
      .finally(() => { submission.cancellation = null })
    submission.cancellation = cancellation
    return cancellation
  }

  function retireSubmission() {
    const submission = scanRef.current
    scanRef.current = null
    if (!submission) return
    submission.retired = true
    if (submission.sessionId) void cancelSubmission(submission)
    // A pending start still owns its reply. Its continuation cancels the returned
    // ID instead of installing an orphan session into a retired modal.
  }

  useEffect(() => {
    liveRef.current = true
    const offs = [
      ipcOn('scan:entry', (e) => {
        if (e.sessionId !== scanRef.current?.sessionId) return
        // The same video can surface twice on a listing page; dedup by sourceUrl so the
        // list keys and the (sourceUrl-keyed) selection stay unambiguous.
        if (seenRef.current.has(e.entry.sourceUrl)) return
        seenRef.current.add(e.entry.sourceUrl)
        pendingRef.current.push(e.entry)
        frameRef.current ??= requestAnimationFrame(flushPending)
      }),
      ipcOn('scan:done', (e) => {
        const submission = scanRef.current
        if (submission && e.sessionId === submission.sessionId) {
          submission.running = false
          setScanning(false)
          setScanned(true)
        }
      }),
      ipcOn('scan:error', (e) => {
        const submission = scanRef.current
        if (submission && e.sessionId === submission.sessionId) {
          submission.running = false
          setScanning(false)
          setScanned(true)
          setError(message('scan.failed'))
        }
      }),
    ]
    return () => {
      liveRef.current = false
      offs.forEach((off) => off())
      resetPending()
      retireSubmission()
    }
  }, [])

  function scan() {
    const v = url.trim()
    if (!v || scanRef.current?.running) return
    retireSubmission()
    const submission: ScanSubmission = {
      sessionId: null, retired: false, running: true, stopRequested: false, stopFailure: null, cancellation: null,
    }
    scanRef.current = submission
    resetPending()
    setEntries([])
    setSelected(new Set())
    setSearch('')
    setError(null)
    setScanned(false)
    setScanning(true)
    void ipcInvoke('scan:start', { url: v })
      .then((r) => {
        submission.sessionId = r.sessionId
        if (submission.retired || submission.stopRequested) void cancelSubmission(submission)
      })
      .catch((err) => {
        submission.running = false
        if (!ownsSubmission(submission)) {
          log.warn('page scan start failed after dismissal', { error: describeError(err) })
          return
        }
        setError(presentFailure(err, message('scan.failed'), 'page scan start failed'))
        setScanning(false)
        setScanned(true)
      })
  }

  async function stopScan() {
    const submission = scanRef.current
    if (!submission) return
    // The user can press Stop before start returns an ID. Keep that intent with
    // the submission so the reply cannot turn it into a running scan later.
    submission.stopRequested = true
    if (submission.sessionId) await cancelSubmission(submission)
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
  const active = activeUrl === null ? undefined : filtered.find((e) => e.sourceUrl === activeUrl)

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
        if (e.alreadyInCollection || e.unavailable) continue
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
      if (liveRef.current) onClose()
    } catch (err) {
      const failure = presentFailure(err, message('scan.addFailed'), 'bulk tape add failed')
      if (liveRef.current) setError(failure)
    } finally {
      if (liveRef.current) setAdding(false)
    }
  }

  // The breakdown line (new / already in the library / unavailable) drawn under
  // the result headline once scanning finishes: entries fall into exactly one of
  // these three per ScanResult's own fields.
  const inCollectionCount = useMemo(() => entries.filter((e) => e.alreadyInCollection).length, [entries])
  const unavailableCount = useMemo(() => entries.filter((e) => e.unavailable !== null).length, [entries])
  const newCount = entries.length - inCollectionCount - unavailableCount
  const breakdownParts: string[] = []
  if (newCount > 0) breakdownParts.push(t.t('scan.breakdownNew', { count: newCount }))
  if (inCollectionCount > 0) breakdownParts.push(t.t('scan.breakdownInCollection', { count: inCollectionCount }))
  if (unavailableCount > 0) breakdownParts.push(t.t('scan.breakdownUnavailable', { count: unavailableCount }))
  const breakdown = t.list(breakdownParts)

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={adding}>{t.t('common.cancel')}</Button>
      <Button variant="primary" onClick={() => void confirm()} disabled={selected.size === 0} loading={adding}>
        {adding ? t.t('scan.adding') : t.t('scan.addTapes', { count: selected.size })}
      </Button>
    </>
  )

  return (
    <Modal title={t.t('scan.title')} onClose={onClose} size="2xl" footer={footer} closeDisabled={adding}>
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
        <p className="mt-3 text-sm text-fg">
          {t.t('scan.intro')}
        </p>
      ) : scanning ? (
        <div className="mt-3">
          <p className="text-sm text-fg">{t.t('scan.scanning')}</p>
          <p className="mt-0.5 text-xs text-fg-muted tabular-nums">{t.t('scan.foundSoFar', { count: entries.length })}</p>
          <div className="mt-2">
            <IndeterminateBar />
          </div>
          {error && <InlineError className="mt-1.5">{t.text(error)}</InlineError>}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-fg">
            <span className="font-semibold tabular-nums text-info-fg">{t.number(entries.length)}</span>{' '}
            {t.t('scan.videosFound', { count: entries.length })}
          </p>
          {breakdownParts.length > 0 && <p className="mt-0.5 text-xs text-fg-muted">{breakdown}</p>}
          {error && <InlineError className="mt-1.5">{t.text(error)}</InlineError>}
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
              const disabled = e.alreadyInCollection || e.unavailable !== null
              const checked = selected.has(e.sourceUrl) && !disabled
              return (
                <li key={e.sourceUrl} style={{ height: ROW_HEIGHT }}>
                  <label
                    onClick={() => setActiveUrl(e.sourceUrl)}
                    className={
                      'flex h-full items-center gap-3 rounded px-2 text-sm ' +
                      (disabled ? 'opacity-50' : 'hover:bg-hover')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      // aria-disabled rather than disabled keeps an unaddable row
                      // focusable, so its full title and reason stay reachable.
                      aria-disabled={disabled || undefined}
                      onChange={() => { if (!disabled) toggle(e.sourceUrl) }}
                      onFocus={() => setActiveUrl(e.sourceUrl)}
                    />
                    {e.alreadyInCollection && <span className="shrink-0 text-xs text-fg-muted">{t.t('tapeState.downloaded')}</span>}
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
          {active && (
            <p className="mt-2 text-xs text-fg wrap-anywhere">
              {active.title ?? active.sourceUrl}
              {active.unavailable && <span className="ml-2">({active.unavailable.reason})</span>}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
