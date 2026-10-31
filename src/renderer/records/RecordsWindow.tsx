import { PagedRunOutput } from './PagedRunOutput'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { I18nProvider, useI18n } from '@renderer/i18n/I18nContext'
import { initialLanguagePreference, useLanguage } from '@renderer/i18n/useInterfaceLanguage'
import { useUiFont } from '@renderer/lib/useUiFont'
import { usePaneSize } from '@renderer/lib/usePaneSize'
import { useRecordPages } from './useRecordPages'
import { useListboxKeyboard } from '@renderer/lib/useListboxKeyboard'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { PassiveScrollRegion } from '@renderer/components/PassiveScrollRegion'
import { IpcCallError } from '@shared/ipc-reply'
import { Button, InlineError } from '@renderer/components/ui'
import { INPUT_LINE_CLASS } from '@renderer/components/ui/input-styles'
import type { LanguagePreference } from '@shared/i18n/languages'
import { displayTimeZone, SYSTEM_TIME_ZONE } from '@shared/time-zone'
import {
  LAYOUT_BOUNDS,
  RECORDS_DETAIL_MIN_WIDTH,
  RECORDS_FILTERS_HEIGHT,
  RECORDS_WINDOW_MIN_HEIGHT,
  RECORDS_WINDOW_MIN_WIDTH,
} from '@shared/layout'
import {
  RECORD_KINDS,
  RECORD_LEVEL_FILTERS,
  type RecordDetail,
  type RecordKind,
  type RecordLevelFilter,
  type RecordSources,
  type RecordsQuery,
  type RecordSummary,
} from '@shared/records'
import {
  KIND_LABELS,
  LEVEL_CLASSES,
  LEVEL_FILTER_LABELS,
  LEVEL_LABELS,
  RUN_STOP_LABELS,
  atTop,
  durationSeconds,
  jsonBlock,
  recordKey,
} from './record-format'

const LIST_WIDTH = LAYOUT_BOUNDS.recordsListWidth

function diagnose(operation: string, error: unknown): void {
  if (!(error instanceof IpcCallError)) log.error(operation, { error: describeError(error) })
}

/**
 * The Records window speaks the interface language from its first text, and
 * follows it when Settings changes it in the main window. Its list pane opens at
 * its saved width, so the first frame already has it.
 */
export function RecordsApp() {
  const [preference, setPreference] = useState<LanguagePreference>(initialLanguagePreference)
  const interfaceLanguage = useLanguage(preference)
  const [listWidth, setListWidth] = useState<number | null>(null)
  const [timeZone, setTimeZone] = useState<string | null>(null)
  const [uiFont, setUiFont] = useState<string | null>(null)
  useUiFont(uiFont ?? '')

  useEffect(() => ipcOn('settings:languageChanged', setPreference), [])
  useEffect(() => ipcOn('settings:timeZoneChanged', setTimeZone), [])
  useEffect(() => ipcOn('settings:uiFontChanged', setUiFont), [])

  // Times show in the saved display zone (timestamp-conventions, Time zones);
  // one that cannot be read leaves System.
  useEffect(() => {
    let cancelled = false
    void ipcInvoke('settings:get').then(
      (settings) => {
        if (!cancelled) {
          setTimeZone((current) => current ?? settings.timeZone)
          setUiFont((current) => current ?? settings.uiFontFamily)
        }
      },
      (error: unknown) => {
        diagnose('records display settings read failed', error)
        if (!cancelled) {
          setTimeZone((current) => current ?? SYSTEM_TIME_ZONE)
          setUiFont((current) => current ?? '')
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void ipcInvoke('layout:get').then(
      (layout) => {
        if (!cancelled) setListWidth(layout.recordsListWidth)
      },
      (error: unknown) => {
        diagnose('records list width read failed', error)
        if (!cancelled) setListWidth(LIST_WIDTH.default)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  if (!interfaceLanguage || listWidth === null || timeZone === null || uiFont === null) {
    const loading = <RecordsLoading />
    return interfaceLanguage ? (
      <I18nProvider language={interfaceLanguage.language} locale={interfaceLanguage.locale}>{loading}</I18nProvider>
    ) : loading
  }
  return (
    <I18nProvider language={interfaceLanguage.language} locale={interfaceLanguage.locale}>
      <RecordsWindow initialListWidth={listWidth} timeZone={displayTimeZone(timeZone)} />
    </I18nProvider>
  )
}

function RecordsLoading() {
  const t = useI18n()
  return <main className="grid h-screen place-items-center text-sm text-fg-muted" role="status">{t.t('common.loading')}</main>
}

type Filters = Omit<RecordsQuery, 'after'>

const NO_FILTERS: Filters = { session: null, kind: null, level: null, tapeId: null, search: '' }
const SEARCH_DELAY_MS = 300
/** New records are read at most this often while they keep arriving. */
const LIVE_INTERVAL_MS = 1000
/** PageUp/PageDown step, as the tape lists take it. */
const LIST_PAGE = 10

type DetailState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; record: RecordDetail }

type Selection = { kind: RecordKind; id: number }

export function RecordsWindow({ initialListWidth, timeZone }: { initialListWidth: number; timeZone: string }) {
  const t = useI18n()
  const [sources, setSources] = useState<RecordSources | null>(null)
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const sourceFailure = useRef(false)
  const requestRefresh = useRef<(retry?: boolean) => void>(() => {})
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [searchText, setSearchText] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<DetailState>({ status: 'none' })
  const [listWidth, setListWidth] = useState(initialListWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  // New records arrived while the list was scrolled away from the top.
  const newestPending = useRef(false)
  // A failed read is itself logged as a record, whose signal would start the
  // next read; live reads stop after a failure and resume after a read succeeds.
  const liveSuspended = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const list = useRecordPages(filters, scrollRef, (error) => {
    liveSuspended.current = true
    diagnose('records read failed', error)
  })
  const pageOwner = useRef(list)
  pageOwner.current = list
  useEffect(() => { if (!list.failed) liveSuspended.current = false }, [list.failed])
  useEffect(() => { newestPending.current = false }, [filters])


  // The list pane keeps its saved width but yields to the detail pane's minimum
  // when the window narrows. The list pane's border-r is on its side.
  const { containerRef: shellRef, displayed: shownListWidth } = usePaneSize<HTMLElement>(dragWidth ?? listWidth, false, {
    siblingMin: RECORDS_DETAIL_MIN_WIDTH,
    min: LIST_WIDTH.min,
    max: LIST_WIDTH.max,
  })

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(t.locale, { dateStyle: 'short', timeStyle: 'medium', timeZone }),
    [t.locale, timeZone],
  )

  useEffect(() => {
    document.title = t.t('records.title')
  }, [t])

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.search === searchText ? current : { ...current, search: searchText }))
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [searchText])

  const readNewest = useCallback((): void => requestRefresh.current(), [])

  // One owner coalesces notifications across both live queries. Successful reads
  // publish before the next read starts, even if notifications never stop.
  useEffect(() => {
    let disposed = false
    let running = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const suspended = () => liveSuspended.current || sourceFailure.current
    const readSources = async () => {
      try {
        const next = await ipcInvoke('records:sources')
        if (disposed) return
        setSources(next)
        sourceFailure.current = false
        setSourcesFailed(false)
      } catch (error) {
        if (disposed) return
        sourceFailure.current = true
        setSourcesFailed(true)
        diagnose('record sources read failed', error)
      }
    }
    const schedule = () => {
      if (disposed || running || timer !== null || !pending || document.hidden || suspended()) return
      timer = setTimeout(() => { timer = null; void run() }, LIVE_INTERVAL_MS)
    }
    const run = async (initial = false) => {
      if (disposed || running || (!initial && (document.hidden || suspended()))) return
      running = true
      pending = false
      const scroll = scrollRef.current
      const refreshList = !initial && (scroll === null || atTop(scroll))
      if (!initial && !refreshList) newestPending.current = true
      // A page that arrives after the list left the top waits too.
      const shown = () => {
        const current = scrollRef.current
        if (current === null || atTop(current)) return true
        newestPending.current = true
        return false
      }
      await Promise.all([readSources(), refreshList ? pageOwner.current.refresh(shown) : undefined])
      running = false
      schedule()
    }
    requestRefresh.current = (retry = false) => {
      if (retry) {
        liveSuspended.current = false
        sourceFailure.current = false
        if (scrollRef.current) scrollRef.current.scrollTop = 0
      }
      pending = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      void run()
    }
    const unsubscribe = ipcOn('records:changed', () => { pending = true; schedule() })
    const visibility = () => {
      if (document.hidden) {
        if (timer !== null) { clearTimeout(timer); timer = null }
      } else if (pending) void run()
    }
    document.addEventListener('visibilitychange', visibility)
    void run(true)
    return () => {
      disposed = true
      requestRefresh.current = () => {}
      unsubscribe()
      document.removeEventListener('visibilitychange', visibility)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  const selectedKey = selected === null ? null : recordKey(selected)

  useEffect(() => {
    if (selected === null) {
      setDetail({ status: 'none' })
      return
    }
    let cancelled = false
    setDetail({ status: 'loading' })
    void ipcInvoke('records:detail', { kind: selected.kind, id: selected.id }).then(
      (record) => {
        if (!cancelled) setDetail(record === null ? { status: 'failed' } : { status: 'ready', record })
      },
      (error: unknown) => {
        if (cancelled) return
        diagnose('record read failed', error)
        setDetail({ status: 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
    // The selection is compared by its key, not by the object holding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const onListScroll = (): void => {
    const scroll = scrollRef.current
    if (scroll === null) return
    if (newestPending.current && atTop(scroll)) {
      newestPending.current = false
      readNewest()
    } else list.onScroll()
  }

  const records = list.status === 'ready' ? list.records : []
  const keys = records.map(recordKey)

  // Stable, so a memoized row renders again only when its own props change.
  const selectedKeyRef = useRef(selectedKey)
  selectedKeyRef.current = selectedKey
  const select = useCallback((record: RecordSummary): void => {
    if (recordKey(record) !== selectedKeyRef.current) setSelected({ kind: record.kind, id: record.id })
  }, [])

  // The list is one listbox (composite-control-conventions, Listbox), through
  // the app's one listbox layer; the selection follows the active row, and
  // reaching the last row reads the next page.
  const kb = useListboxKeyboard<HTMLDivElement>({
    itemIds: keys,
    activeId: selectedKey !== null && keys.includes(selectedKey) ? selectedKey : null,
    onActivate: (key) => {
      const index = keys.indexOf(key)
      const record = records[index]
      if (record) select(record)
      if (index === keys.length - 1) list.loadMore()
    },
    idPrefix: 'record',
    page: LIST_PAGE,
  })

  // A drag is the user's intended width, which a narrower window only overrides
  // for display. Only the end of a drag saves.
  const commitListWidth = (width: number): void => {
    setListWidth(width)
    setDragWidth(null)
    void ipcInvoke('layout:update', { recordsListWidth: width }).then(
      (layout) => setListWidth(layout.recordsListWidth),
      (error: unknown) => diagnose('records list width save failed', error),
    )
  }

  const launchLabel = (session: string): string => {
    const time = timeFormat.format(new Date(session))
    return session === sources?.currentSession ? t.t('records.thisLaunch', { time }) : time
  }

  return (
    <div className="h-screen overflow-hidden">
      <main
        ref={shellRef}
        className="flex h-full"
        style={{ minWidth: RECORDS_WINDOW_MIN_WIDTH, minHeight: RECORDS_WINDOW_MIN_HEIGHT }}
      >
        <section
          aria-label={t.t('records.title')}
          style={{ width: shownListWidth }}
          className="relative flex shrink-0 flex-col border-r border-line"
        >
          <div className="flex shrink-0 flex-col justify-center space-y-2 border-b border-line px-3" style={{ height: RECORDS_FILTERS_HEIGHT }}>
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t.t('records.search')}
              aria-label={t.t('records.search')}
              spellCheck={false}
              className={`block w-full ${INPUT_LINE_CLASS}`}
            />
            <div className="grid grid-cols-2 gap-2">
              <FilterSelect
                label={t.t('records.launch')}
                value={filters.session}
                allLabel={t.t('records.allLaunches')}
                options={(sources?.sessions ?? []).map((session) => ({ value: session, label: launchLabel(session) }))}
                onChange={(session) => setFilters({ ...filters, session })}
              />
              <FilterSelect
                label={t.t('records.tape')}
                value={filters.tapeId}
                allLabel={t.t('records.allTapes')}
                options={(sources?.tapes ?? []).map((tape) => ({ value: tape.tapeId, label: tape.name ?? tape.tapeId }))}
                onChange={(tapeId) => setFilters({ ...filters, tapeId })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <FilterSelect
                label={t.t('records.kind')}
                value={filters.kind}
                allLabel={t.t('records.allKinds')}
                options={RECORD_KINDS.map((kind) => ({ value: kind, label: t.t(KIND_LABELS[kind]) }))}
                onChange={(kind) => setFilters({ ...filters, kind: kind as RecordKind | null })}
              />
              <FilterSelect
                label={t.t('records.level')}
                value={filters.level}
                allLabel={t.t('records.allLevels')}
                options={RECORD_LEVEL_FILTERS.map((level) => ({ value: level, label: t.t(LEVEL_FILTER_LABELS[level]) }))}
                onChange={(level) => setFilters({ ...filters, level: level as RecordLevelFilter | null })}
              />
            </div>
          </div>
          {(list.failed || sourcesFailed) && (
            <div className="m-3 flex items-center gap-2">
              <InlineError>{t.t('records.loadFailed')}</InlineError>
              <Button onClick={() => requestRefresh.current(true)}>{t.t('common.tryAgain')}</Button>
            </div>
          )}
          <div
            ref={scrollRef}
            data-records-scroll
            className="relative min-h-0 flex-1 overflow-y-auto"
            aria-busy={list.status === 'loading' || list.loadingMore}
            onScroll={onListScroll}
          >
            {list.status === 'failed' ? null : list.status === 'loading' ? (
              <p className="p-4 text-sm text-fg">{t.t('records.loading')}</p>
            ) : records.length === 0 ? (
              <p className="p-4 text-sm text-fg">{t.t('records.empty')}</p>
            ) : (
              <div
                ref={kb.ref}
                {...kb.listboxProps}
                aria-label={t.t('records.title')}
                className="space-y-1 p-2 outline-none"
              >
                {records.map((record) => {
                  const key = recordKey(record)
                  return (
                    <RecordRow
                      key={key}
                      record={record}
                      id={kb.optionId(key)}
                      selected={key === selectedKey}
                      onSelect={select}
                      timeFormat={timeFormat}
                    />
                  )
                })}
              </div>
            )}
            {list.status === 'ready' && list.loadingMore && (
              <p className="p-4 text-sm text-fg">{t.t('records.loading')}</p>
            )}
          </div>
          <ResizeHandle
            edge="right"
            size={shownListWidth}
            min={LIST_WIDTH.min}
            max={LIST_WIDTH.max}
            onResize={setDragWidth}
            onCommit={commitListWidth}
            keyboardLabel={t.t('records.listWidth')}
          />
        </section>
        <section
          className="flex min-w-0 flex-1 flex-col"
          style={{ minWidth: RECORDS_DETAIL_MIN_WIDTH }}
          aria-busy={detail.status === 'loading'}
        >
          {detail.status === 'ready' ? (
            <RecordDetailView record={detail.record} tapes={sources?.tapes ?? []} launchLabel={launchLabel} timeZone={timeZone} />
          ) : detail.status === 'failed' ? (
            <InlineError className="m-4">{t.t('records.detailFailed')}</InlineError>
          ) : detail.status === 'none' ? (
            <div className="flex h-full items-center justify-center p-8 text-sm text-fg">{t.t('records.noSelection')}</div>
          ) : null}
        </section>
      </main>
    </div>
  )
}

/** One row of the list. Memoized, so loading the next page or a new selection
 * renders only the rows that changed, not every row already loaded. */
const RecordRow = memo(function RecordRow({ record, id, selected, onSelect, timeFormat }: {
  record: RecordSummary
  id: string
  selected: boolean
  onSelect: (record: RecordSummary) => void
  timeFormat: Intl.DateTimeFormat
}) {
  const t = useI18n()
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-record-key={recordKey(record)}
      onClick={() => onSelect(record)}
      className={
        'listbox-item cursor-pointer rounded border px-3 py-2 transition ' +
        (selected
          ? 'border-selected ring-1 ring-inset ring-selected/40'
          : 'border-transparent hover:bg-hover')
      }
    >
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
        <span className="tabular-nums">{timeFormat.format(new Date(record.time))}</span>
        <span className={`font-medium ${LEVEL_CLASSES[record.level]}`}>{t.t(LEVEL_LABELS[record.level])}</span>
        {record.kind !== 'log' && <span>{t.t(KIND_LABELS[record.kind])}</span>}
      </div>
      <div className="mt-0.5 truncate text-sm text-fg-strong" data-record-title data-literal>{record.title}</div>
      {record.text && <div className="line-clamp-2 text-xs text-fg wrap-anywhere" data-literal>{record.text}</div>}
    </div>
  )
})

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string
  value: string | null
  allLabel: string
  options: { value: string; label: string }[]
  onChange: (value: string | null) => void
}) {
  // A chosen value the sources no longer list stays selectable until changed.
  const shown = value === null || options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options]
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      className={`block w-full min-w-0 text-ellipsis ${INPUT_LINE_CLASS}`}
    >
      <option value="">{allLabel}</option>
      {shown.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

function recordTitle(record: RecordDetail): string {
  if (record.kind === 'log') return record.message
  if (record.kind === 'ai-call') return record.model
  return `${record.kind === 'ytdlp-run' ? 'yt-dlp' : 'ffmpeg'} ${record.run}`
}

function RecordDetailView({
  record,
  tapes,
  launchLabel,
  timeZone,
}: {
  record: RecordDetail
  tapes: RecordSources['tapes']
  launchLabel: (session: string) => string
  timeZone: string
}) {
  const t = useI18n()
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(t.locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        timeZone,
      }),
    [t.locale, timeZone],
  )
  const secondsFormat = useMemo(
    () => new Intl.NumberFormat(t.locale, { style: 'unit', unit: 'second', minimumFractionDigits: 3, maximumFractionDigits: 3 }),
    [t.locale],
  )
  const time = (value: string): string => timeFormat.format(new Date(value))
  const tapeName = record.tapeId === null ? null : (tapes.find((tape) => tape.tapeId === record.tapeId)?.name ?? null)
  const level = record.level

  const fields: { label: string; value: ReactNode }[] = []
  const add = (label: string, value: ReactNode | null): void => {
    if (value !== null) fields.push({ label, value })
  }
  const code = (value: string | null): ReactNode | null => (value === null ? null : <code className="font-mono text-xs" data-literal>{value}</code>)
  if (record.kind === 'log') {
    add(t.t('records.time'), time(record.time))
  } else {
    add(t.t('records.started'), time(record.startedAt))
    add(t.t('records.finished'), time(record.endedAt))
    add(t.t('records.duration'), secondsFormat.format(record.elapsedMs == null ? durationSeconds(record.startedAt, record.endedAt) : record.elapsedMs / 1000))
  }
  if (record.kind === 'ai-call') {
    add(t.t('records.model'), code(record.model))
    add(t.t('settings.endpoint'), code(record.endpoint))
    add(t.t('records.status'), record.status === null ? null : t.number(record.status))
  }
  if (record.kind === 'ytdlp-run' || record.kind === 'ffmpeg-run') {
    add(t.t('records.operation'), code(record.run))
    if (record.kind === 'ytdlp-run') add(t.t('records.url'), code(record.url))
    add(t.t('records.exitCode'), record.exitCode === null ? null : code(String(record.exitCode)))
    add(t.t('records.signal'), code(record.signal))
    add(t.t('records.stopped'), record.stopReason === null ? null : t.t(RUN_STOP_LABELS[record.stopReason]))
  }
  add(
    t.t('records.tape'),
    record.tapeId === null ? null : (
      <span className="grid gap-0.5">
        {tapeName !== null && <span data-literal>{tapeName}</span>}
        {code(record.tapeId)}
      </span>
    ),
  )
  if (record.kind === 'ytdlp-run') add(t.t('records.scan'), code(record.scanId))
  add(t.t('records.launch'), launchLabel(record.session))

  const blocks: { label: string; text: string }[] = []
  const addBlock = (label: string, text: string | null): void => {
    if (text !== null) blocks.push({ label, text })
  }
  if (record.kind === 'log') {
    // A string tapeId field is the row's own tape, shown above as the Tape field.
    addBlock(t.t('records.details'), jsonBlock(record.fields, record.tapeId === null ? {} : { tapeId: record.tapeId }))
  } else if (record.kind === 'ai-call') {
    if (record.request !== null) addBlock(t.t('records.request'), jsonBlock(record.request))
    if (record.response !== null) addBlock(t.t('records.response'), jsonBlock(record.response))
    if (record.error !== null) addBlock(t.t('records.error'), jsonBlock(record.error))
  } else {
    addBlock(t.t('records.arguments'), jsonBlock(record.args))
  }

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="min-w-0 text-lg font-medium wrap-anywhere">{recordTitle(record)}</h2>
        <div className="flex shrink-0 items-center gap-3 pt-1 text-xs">
          <span className={`font-medium ${LEVEL_CLASSES[level]}`}>{t.t(LEVEL_LABELS[level])}</span>
          <span className="text-fg-muted">{t.t(KIND_LABELS[record.kind])}</span>
        </div>
      </div>
      <PassiveScrollRegion
        label={t.t('records.details')}
        className="relative min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        data-records-detail
      >
        <dl className="flex flex-wrap gap-x-4 gap-y-3">
          {fields.map((field) => (
            <div key={field.label} className="min-w-[180px] max-w-full flex-initial">
              <dt className="text-xs text-fg-subtle">{field.label}</dt>
              <dd className="mt-0.5 text-sm text-fg-strong wrap-anywhere">{field.value}</dd>
            </div>
          ))}
        </dl>
        {blocks.map((block) => (
          <section key={block.label} className="min-w-0" data-records-block>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{block.label}</h3>
            <pre className="whitespace-pre-wrap rounded border border-line bg-panel px-3 py-2 font-mono text-xs text-fg wrap-anywhere" data-literal>
              {block.text}
            </pre>
          </section>
        ))}
        {(record.kind === 'ytdlp-run' || record.kind === 'ffmpeg-run') && <>
          {record.outputStatus !== 'complete' && <p className="text-xs text-fg-muted">
            {t.t(record.outputStatus === 'incomplete' ? 'records.outputIncomplete' : 'records.outputUnknown')}
          </p>}
          <PagedRunOutput kind={record.kind} id={record.id} stream="stdout" label={t.t('records.output')} initial={{ text: record.stdout, more: record.stdoutMore }} />
          <PagedRunOutput kind={record.kind} id={record.id} stream="stderr" label={t.t('records.errorOutput')} initial={{ text: record.stderr, more: record.stderrMore }} />
        </>}
      </PassiveScrollRegion>
    </>
  )
}
