import { PagedRunOutput } from './PagedRunOutput'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { I18nProvider, useI18n } from '@renderer/i18n/I18nContext'
import { initialLanguagePreference, useLanguage } from '@renderer/i18n/useInterfaceLanguage'
import { usePaneSize } from '@renderer/lib/usePaneSize'
import { useRecordPages } from './useRecordPages'
import { useListboxKeyboard } from '@renderer/lib/useListboxKeyboard'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { PassiveScrollRegion } from '@renderer/components/PassiveScrollRegion'
import { InlineError } from '@renderer/components/ui'
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
  log.error(operation, { error: describeError(error) })
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

  useEffect(() => ipcOn('settings:languageChanged', setPreference), [])
  useEffect(() => ipcOn('settings:timeZoneChanged', setTimeZone), [])

  // Times show in the saved display zone (timestamp-conventions, Time zones);
  // one that cannot be read leaves System.
  useEffect(() => {
    let cancelled = false
    void ipcInvoke('settings:get').then(
      (settings) => {
        if (!cancelled) setTimeZone((current) => current ?? settings.timeZone)
      },
      (error: unknown) => {
        diagnose('records display zone read failed', error)
        if (!cancelled) setTimeZone((current) => current ?? SYSTEM_TIME_ZONE)
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

  if (!interfaceLanguage || listWidth === null || timeZone === null) {
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
  const [sourceReads, setSourceReads] = useState(0)
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

  useEffect(() => {
    let cancelled = false
    void ipcInvoke('records:sources').then(
      (next) => {
        if (!cancelled) setSources(next)
      },
      (error: unknown) => {
        liveSuspended.current = true
        diagnose('record sources read failed', error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [sourceReads])

  const readNewest = useCallback((): void => { void pageOwner.current.refresh() }, [])

  // A stored record reaches the list at once while it is scrolled to the top;
  // otherwise it waits until the list is back there, so the list never moves
  // under the reader.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = ipcOn('records:changed', () => {
      if (timer !== null || liveSuspended.current) return
      timer = setTimeout(() => {
        timer = null
        setSourceReads((count) => count + 1)
        const scroll = scrollRef.current
        if (scroll === null || atTop(scroll)) readNewest()
        else newestPending.current = true
      }, LIVE_INTERVAL_MS)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [readNewest])

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
  const recordOffsets = useMemo(() => {
    const offsets = [0]
    for (const page of list.pages) offsets.push(offsets.at(-1)! + page.count)
    return offsets
  }, [list.pages])

  const select = (record: RecordSummary): void => {
    list.activate(record)
    if (recordKey(record) !== selectedKey) setSelected({ kind: record.kind, id: record.id })
  }

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
    onCommandKey: (event) => {
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return false
      event.preventDefault()
      void list.navigate(event.key).then((record) => { if (record) select(record) })
      return true
    },
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
          <div
            ref={scrollRef}
            data-records-scroll
            className="relative min-h-0 flex-1 overflow-y-auto"
            aria-busy={list.status === 'loading' || list.pending.size > 0}
            onScroll={onListScroll}
          >
            {list.status === 'failed' ? (
              <InlineError className="m-3">{t.t('records.loadFailed')}</InlineError>
            ) : list.status === 'loading' ? (
              <p className="p-4 text-sm text-fg">{t.t('records.loading')}</p>
            ) : list.pages.every((page) => page.count === 0) ? (
              <p className="p-4 text-sm text-fg">{t.t('records.empty')}</p>
            ) : (
              <div
                ref={kb.ref}
                {...kb.listboxProps}
                aria-label={t.t('records.title')}
                className="p-2 outline-none"
              >
                {list.pages.map((page, index) => {
                  const cached = list.cache.get(index)
                  return cached ? (
                    <div key={index} ref={list.pageRef(index)} data-record-page={index} className="space-y-1 pb-1">
                      {cached.map((record, rowIndex) => {
                        const key = recordKey(record)
                        const isSelected = key === selectedKey
                        return (
                          <div
                            key={key}
                            id={kb.optionId(key)}
                            role="option"
                            aria-selected={isSelected}
                            aria-posinset={recordOffsets[index]! + rowIndex + 1}
                            aria-setsize={list.pages.at(-1)?.more ? -1 : recordOffsets.at(-1)}
                            data-record-key={key}
                            onClick={() => select(record)}
                            className={
                              'listbox-item cursor-pointer rounded border px-3 py-2 transition ' +
                              (isSelected
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
                      })}
                    </div>
                  ) : <div key={index} role="presentation" aria-hidden="true" style={{ height: page.height }} />
                })}
              </div>
            )}
            {list.status === 'ready' && list.pending.size > 0 && (
              <p className="p-4 text-sm text-fg">{t.t('records.loading')}</p>
            )}
            {list.status === 'ready' && list.moreFailed && (
              <InlineError className="m-3">{t.t('records.loadFailed')}</InlineError>
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
          <PagedRunOutput kind={record.kind} id={record.id} stream="stdout" label={t.t('records.output')} initial={{ text: record.stdout, more: record.stdoutMore }} />
          <PagedRunOutput kind={record.kind} id={record.id} stream="stderr" label={t.t('records.errorOutput')} initial={{ text: record.stderr, more: record.stderrMore }} />
        </>}
      </PassiveScrollRegion>
    </>
  )
}
