import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SCAN_PAGE_SIZE, type ScanPage, type ScanResult } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
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
  pageFailure: Message | null
  cancellation: Promise<void> | null
  released: boolean
}
const ROW_HEIGHT = 32

/** Main owns the full result set and selection. The modal retains one viewport
 * page and the active row's title; a single request coalesces polling and input. */
export function ScanPageModal({ onClose, initialUrl = '' }: Props) {
  const { url, setUrl, onPaste } = useClipboardUrl(true, initialUrl)
  const { composingRef, handlers: composing } = useComposing()
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [page, setPage] = useState<ScanPage | null>(null)
  const [error, setError] = useState<Message | null>(null)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [active, setActive] = useState<ScanResult | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const t = useI18n()
  const liveRef = useRef(true)
  const scanRef = useRef<ScanSubmission | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const queryRef = useRef({ search: '', start: 0, revision: 0 })
  const pageInFlight = useRef(false)
  const pagePending = useRef(false)
  const addingRef = useRef(false)
  const selectingRef = useRef(false)
  const refreshRef = useRef<() => void>(() => {})

  function ownsSubmission(submission: ScanSubmission): boolean {
    return liveRef.current && !submission.retired && scanRef.current === submission
  }

  function refreshPage() {
    const submission = scanRef.current
    if (!liveRef.current || !submission?.sessionId || addingRef.current || selectingRef.current) return
    if (pageInFlight.current) { pagePending.current = true; return }
    pageInFlight.current = true
    pagePending.current = false
    const query = { ...queryRef.current }
    void ipcInvoke('scan:page', { sessionId: submission.sessionId, search: query.search, start: query.start })
      .then((result) => {
        if (!ownsSubmission(submission) || query.revision !== queryRef.current.revision) return
        setPage(result)
        setSelecting(false)
        if (submission.pageFailure) {
          const previous = submission.pageFailure
          submission.pageFailure = null
          setError((current) => current === previous ? null : current)
        }
        submission.running = result.status === 'running'
        setScanning(submission.running)
        setScanned(true)
        if (result.status === 'failed') setError(message('scan.failed'))
      })
      .catch((err) => {
        if (!ownsSubmission(submission) || query.revision !== queryRef.current.revision) return
        setSelecting(false)
        submission.pageFailure = presentFailure(err, message('scan.failed'), 'page scan results failed')
        setError(submission.pageFailure)
      })
      .finally(() => {
        pageInFlight.current = false
        if (liveRef.current && pagePending.current) refreshRef.current()
      })
  }
  refreshRef.current = refreshPage

  function changeQuery(nextSearch: string, start: number) {
    queryRef.current = { search: nextSearch, start, revision: queryRef.current.revision + 1 }
    refreshRef.current()
  }

  function releaseSubmission(submission: ScanSubmission) {
    if (!submission.sessionId || submission.released) return
    submission.released = true
    const sessionId = submission.sessionId
    void ipcInvoke('scan:release', { sessionId }).catch((err) => {
      log.warn('page scan release failed', { sessionId, error: describeError(err) })
    })
  }

  function retireSubmission() {
    const submission = scanRef.current
    scanRef.current = null
    queryRef.current.revision += 1
    pagePending.current = false
    if (!submission) return
    submission.retired = true
    releaseSubmission(submission)
  }

  function cancelSubmission(submission: ScanSubmission): Promise<void> {
    if (submission.cancellation) return submission.cancellation
    if (!submission.sessionId) return Promise.resolve()
    const sessionId = submission.sessionId
    queryRef.current.revision += 1
    const cancellation = ipcInvoke('scan:cancel', { sessionId })
      .then(() => {
        submission.running = false
        if (!ownsSubmission(submission)) return
        const previous = submission.stopFailure
        submission.stopFailure = null
        if (previous) setError((current) => current === previous ? null : current)
        setScanning(false)
        setScanned(true)
        refreshRef.current()
      })
      .catch((err) => {
        if (ownsSubmission(submission)) {
          submission.stopRequested = false
          submission.stopFailure = presentFailure(err, message('scan.stopFailed'), 'page scan cancellation failed')
          setError(submission.stopFailure)
        } else log.warn('page scan cancellation failed after dismissal', { sessionId, error: describeError(err) })
      })
      .finally(() => { submission.cancellation = null })
    submission.cancellation = cancellation
    return cancellation
  }

  useEffect(() => {
    liveRef.current = true
    const timer = setInterval(() => {
      const submission = scanRef.current
      if (submission && (submission.running || submission.pageFailure) && !document.hidden) refreshRef.current()
    }, 250)
    return () => {
      liveRef.current = false
      clearInterval(timer)
      retireSubmission()
    }
  }, [])

  function scan() {
    const v = url.trim()
    if (!v || scanRef.current?.running || addingRef.current || selectingRef.current || selecting) return
    retireSubmission()
    const submission: ScanSubmission = {
      sessionId: null, retired: false, running: true, stopRequested: false,
      stopFailure: null, pageFailure: null, cancellation: null, released: false,
    }
    scanRef.current = submission
    queryRef.current = { search: '', start: 0, revision: queryRef.current.revision + 1 }
    setPage(null)
    setSearch('')
    setActive(null)
    setScrollTop(0)
    if (listRef.current) listRef.current.scrollTop = 0
    setError(null)
    setScanned(false)
    setScanning(true)
    void ipcInvoke('scan:start', { url: v })
      .then((result) => {
        submission.sessionId = result.sessionId
        if (!ownsSubmission(submission)) releaseSubmission(submission)
        else if (submission.stopRequested) void cancelSubmission(submission)
        else refreshRef.current()
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
    if (!submission || addingRef.current) return
    submission.stopRequested = true
    if (submission.sessionId) await cancelSubmission(submission)
  }

  const total = page?.total ?? 0
  const matched = page?.matched ?? 0
  const selected = page?.selected ?? 0
  useLayoutEffect(() => {
    if (listRef.current) setViewportHeight(listRef.current.clientHeight)
  }, [matched])
  const range = visibleRowRange(scrollTop, viewportHeight, ROW_HEIGHT, matched)
  // A previous page below the new viewport cannot stand in for its first row.
  // Keep the scroll extent while the matching page is fetched on upward scroll.
  const visibleRows = page && page.start <= range.start
    ? page.entries.slice(range.start - page.start, Math.max(0, range.end - page.start))
    : []
  // The transport contract bounds a page; never expand a renderer cache to match
  // the result count. Scroll requests replace this page instead of appending.
  const rows = visibleRows.slice(0, SCAN_PAGE_SIZE)

  async function select(selected: boolean, sourceUrl?: string) {
    const submission = scanRef.current
    if (!submission?.sessionId || addingRef.current || selectingRef.current || selecting) return
    selectingRef.current = true
    setSelecting(true)
    setError(null)
    queryRef.current.revision += 1
    try {
      await ipcInvoke('scan:select', { sessionId: submission.sessionId, selected, ...(sourceUrl ? { sourceUrl } : { search }) })
    } catch (err) {
      if (ownsSubmission(submission)) setError(presentFailure(err, message('scan.failed'), 'page scan selection failed'))
    } finally {
      selectingRef.current = false
      if (ownsSubmission(submission)) refreshRef.current()
    }
  }

  async function confirm() {
    const submission = scanRef.current
    if (!submission?.sessionId || selected === 0 || addingRef.current || selectingRef.current || selecting) return
    addingRef.current = true
    setAdding(true)
    setError(null)
    queryRef.current.revision += 1
    try {
      await ipcInvoke('scan:add', { sessionId: submission.sessionId })
      if (ownsSubmission(submission)) onClose()
    } catch (err) {
      const failure = presentFailure(err, message('scan.addFailed'), 'bulk tape add failed')
      if (ownsSubmission(submission)) setError(failure)
    } finally {
      addingRef.current = false
      if (ownsSubmission(submission)) { setAdding(false); refreshRef.current() }
    }
  }

  const inLibraryCount = page?.inLibrary ?? 0
  const unavailableCount = page?.unavailable ?? 0
  const newCount = total - inLibraryCount - unavailableCount
  const breakdownParts: string[] = []
  if (newCount > 0) breakdownParts.push(t.t('scan.breakdownNew', { count: newCount }))
  if (inLibraryCount > 0) breakdownParts.push(t.t('scan.breakdownInLibrary', { count: inLibraryCount }))
  if (unavailableCount > 0) breakdownParts.push(t.t('scan.breakdownUnavailable', { count: unavailableCount }))
  const breakdown = t.list(breakdownParts)

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={adding}>{t.t('common.cancel')}</Button>
      <Button variant="primary" onClick={() => void confirm()} disabled={selected === 0 || selecting || adding} loading={adding}>
        {adding ? t.t('scan.adding') : t.t('scan.addTapes', { count: selected })}
      </Button>
    </>
  )

  return (
    <Modal title={t.t('scan.title')} onClose={onClose} size="2xl" footer={footer} closeDisabled={adding}>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          disabled={adding}
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
          disabled={adding || selecting || (!scanning && !url.trim())}
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
          <p className="mt-0.5 text-xs text-fg-muted tabular-nums">{t.t('scan.foundSoFar', { count: total })}</p>
          <div className="mt-2">
            <IndeterminateBar />
          </div>
          {error && <InlineError className="mt-1.5">{t.text(error)}</InlineError>}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-fg">
            <span className="font-semibold tabular-nums text-info-fg">{t.number(total)}</span>{' '}
            {t.t('scan.videosFound', { count: total })}
          </p>
          {breakdownParts.length > 0 && <p className="mt-0.5 text-xs text-fg-muted">{breakdown}</p>}
          {error && <InlineError className="mt-1.5">{t.text(error)}</InlineError>}
        </div>
      )}

      {total > 0 && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={adding || selecting} onClick={() => void select(true)}>{t.t('scan.selectAll')}</Button>
            <Button variant="secondary" size="sm" disabled={adding || selecting} onClick={() => void select(false)}>{t.t('scan.clearSelection')}</Button>
            <input
              type="text"
              value={search}
              disabled={adding}
              onChange={(e) => {
                setSearch(e.target.value)
                setActive(null)
                setPage((current) => current ? { ...current, entries: [] } : current)
                changeQuery(e.target.value, 0)
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
              const top = event.currentTarget.scrollTop
              const height = event.currentTarget.clientHeight
              const start = visibleRowRange(top, height, ROW_HEIGHT, matched).start
              if (start !== queryRef.current.start) changeQuery(search, start)
              setScrollTop(top)
              setViewportHeight(event.currentTarget.clientHeight)
            }}
            style={{
              paddingTop: range.start * ROW_HEIGHT,
              paddingBottom: (matched - range.start - rows.length) * ROW_HEIGHT,
            }}
          >
            {rows.map((e) => {
              const disabled = e.alreadyInLibrary || e.unavailable !== null
              const checked = e.selected && !disabled
              return (
                <li key={e.sourceUrl} style={{ height: ROW_HEIGHT }}>
                  <label
                    onClick={() => setActive(e)}
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
                      aria-disabled={disabled || adding || selecting || undefined}
                      onChange={() => { if (!disabled) void select(!e.selected, e.sourceUrl) }}
                      onFocus={() => setActive(e)}
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
