import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import type { RecordCursor, RecordsPage, RecordsQuery, RecordSummary } from '@shared/records'
import { cursorAfter, nearEnd, recordKey } from './record-format'

type Filters = Omit<RecordsQuery, 'after'>
type Descriptor = { after: RecordCursor | null; next: RecordCursor | null; count: number; height: number; more: boolean }
type State = {
  status: 'loading' | 'failed' | 'ready'
  pages: Descriptor[]
  cache: Map<number, RecordSummary[]>
  moreFailed: boolean
  failed: boolean
  pending: Set<number>
}
const empty = (): State => ({ status: 'loading', pages: [], cache: new Map(), pending: new Set(), moreFailed: false, failed: false })
// Used only until a real page has been measured; rows keep their natural height.
const ESTIMATED_ROW_HEIGHT = 88

/** Cursor history is compact and survives cache eviction. Only viewport pages
 * and one neighboring page on each side retain summaries and mounted rows. */
export function useRecordPages(filters: Filters, viewportRef: RefObject<HTMLElement | null>, onFailure: (error: unknown) => void) {
  const [state, setState] = useState<State>(empty)
  const current = useRef(state)
  const generation = useRef(0)
  const refreshing = useRef(false)
  const query = useRef(filters)
  const requests = useRef(new Map<number, Promise<RecordSummary[] | undefined>>())
  const keyboard = useRef<{ page: number; row: number } | null>(null)
  const nodes = useRef(new Map<number, HTMLElement>())
  const resize = useRef<ResizeObserver | null>(null)
  const failure = useRef(onFailure)
  failure.current = onFailure

  function publish(next: State) { current.current = next; setState(next) }
  function offsets() {
    const values = [0]
    for (const page of current.current.pages) values.push(values.at(-1)! + page.height)
    return values
  }
  function wanted() {
    const pages = current.current.pages
    const scroll = viewportRef.current
    const top = scroll?.scrollTop ?? 0
    const bottom = top + (scroll?.clientHeight ?? 0)
    const edges = offsets()
    let first = pages.findIndex((_page, index) => edges[index + 1]! > top)
    if (first < 0) first = Math.max(0, pages.length - 1)
    let last = first
    while (last + 1 < pages.length && edges[last + 1]! < bottom) last += 1
    const result = new Set<number>()
    for (let index = Math.max(0, first - 1); index <= Math.min(pages.length - 1, last + 1); index++) result.add(index)
    return result
  }
  function prune() {
    const keep = wanted()
    const cache = new Map([...current.current.cache].filter(([index]) => keep.has(index)))
    if (cache.size !== current.current.cache.size) publish({ ...current.current, cache })
  }
  function read(index: number): Promise<RecordSummary[] | undefined> {
    if (refreshing.current) return Promise.resolve(undefined)
    const running = requests.current.get(index)
    if (running) return running
    const existing = current.current.cache.get(index)
    if (existing) return Promise.resolve(existing)
    const epoch = generation.current
    const prior = current.current.pages[index - 1]
    const after = current.current.pages[index]?.after ?? prior?.next ?? null
    publish({ ...current.current, pending: new Set([...current.current.pending, index]), moreFailed: false })
    const task = ipcInvoke('records:page', { ...query.current, after }).then((page: RecordsPage) => {
      if (epoch !== generation.current) return undefined
      const old = current.current
      const pages = [...old.pages]
      const previous = pages[index]
      if (!previous && index > 0 && page.records.length === 0) {
        pages[index - 1] = { ...pages[index - 1]!, more: false }
        const pending = new Set(old.pending); pending.delete(index)
        publish({ ...old, pages, pending, failed: false, moreFailed: false })
        return page.records
      }
      pages[index] = {
        after, next: cursorAfter(page.records), count: page.records.length,
        height: previous?.height ?? page.records.length * ESTIMATED_ROW_HEIGHT,
        more: page.more && page.records.length > 0,
      }
      const cache = new Map(old.cache).set(index, page.records)
      const pending = new Set(old.pending); pending.delete(index)
      publish({ ...old, status: 'ready', pages, cache, pending, failed: false, moreFailed: false })
      prune()
      return page.records
    }, (error: unknown) => {
      if (epoch !== generation.current) return undefined
      const pending = new Set(current.current.pending); pending.delete(index)
      publish({ ...current.current, status: current.current.pages.length ? 'ready' : 'failed', pending, failed: true, moreFailed: true })
      failure.current(error)
      return undefined
    }).finally(() => { if (epoch === generation.current) requests.current.delete(index) })
    requests.current.set(index, task)
    return task
  }
  function loadMore() {
    if (refreshing.current) return
    const last = current.current.pages.at(-1)
    if (!last?.more) return
    void read(current.current.pages.length)
  }
  function sync() {
    if (refreshing.current || current.current.status !== 'ready') return
    prune()
    for (const index of wanted()) if (!current.current.cache.has(index)) void read(index)
    const scroll = viewportRef.current
    if (scroll && nearEnd(scroll)) loadMore()
  }
  function reset() {
    refreshing.current = false
    generation.current += 1
    requests.current.clear()
    keyboard.current = null
    publish(empty())
    if (viewportRef.current) viewportRef.current.scrollTop = 0
    return read(0)
  }
  // Refresh invalidates every cursor: new records can change page boundaries.
  function refresh() {
    generation.current += 1
    requests.current.clear()
    keyboard.current = null
    refreshing.current = true
    // Preserve the displayed history while the newest page is pending. Its
    // cursor generation is already retired, so no old-boundary reads may start.
    publish({ ...current.current, pending: new Set() })
    const epoch = generation.current
    const task = ipcInvoke('records:page', { ...query.current, after: null }).then((page) => {
      if (epoch !== generation.current) return
      refreshing.current = false
      const descriptor = { after: null, next: cursorAfter(page.records), count: page.records.length, height: page.records.length * ESTIMATED_ROW_HEIGHT, more: page.more && page.records.length > 0 }
      publish({ status: 'ready', pages: [descriptor], cache: new Map([[0, page.records]]), pending: new Set(), failed: false, moreFailed: false })
    }, (error: unknown) => {
      if (epoch !== generation.current) return
      refreshing.current = false
      publish({ ...current.current, failed: true })
      failure.current(error)
    })
    return task
  }
  useEffect(() => {
    query.current = filters
    void reset()
    return () => { generation.current += 1; requests.current.clear() }
  }, [filters])

  useEffect(() => {
    if (state.status === 'ready' && !state.moreFailed && state.pending.size === 0) sync()
  }, [state.pages, state.cache, state.pending, state.status, state.moreFailed])

  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let pages = current.current.pages
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.recordPage)
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height
        if (nodes.current.get(index) !== entry.target || !pages[index] || height <= 0 || pages[index]!.height === height) continue
        pages = [...pages]; pages[index] = { ...pages[index]!, height }
      }
      if (pages !== current.current.pages) publish({ ...current.current, pages })
    })
    resize.current = observer
    for (const node of nodes.current.values()) observer.observe(node)
    const scroll = viewportRef.current
    const viewportResize = new ResizeObserver(sync)
    if (scroll) viewportResize.observe(scroll)
    return () => { observer.disconnect(); viewportResize.disconnect(); resize.current = null }
  }, [viewportRef])

  function pageRef(index: number) {
    return (node: HTMLElement | null) => {
      const previous = nodes.current.get(index)
      if (previous) resize.current?.unobserve(previous)
      if (node) { nodes.current.set(index, node); resize.current?.observe(node) }
      else nodes.current.delete(index)
    }
  }
  function activate(record: RecordSummary) {
    for (const [page, records] of current.current.cache) {
      const row = records.findIndex((candidate) => recordKey(candidate) === recordKey(record))
      if (row >= 0) { keyboard.current = { page, row }; break }
    }
  }
  async function navigate(key: string): Promise<RecordSummary | undefined> {
    if (refreshing.current || !current.current.pages.length) return undefined
    const epoch = generation.current
    const position = keyboard.current ?? { page: Math.min(...wanted()), row: -1 }
    let { page, row } = position
    if (key === 'Home') { page = 0; row = 0 }
    else if (key === 'End') { page = current.current.pages.length - 1; row = current.current.pages[page]!.count - 1 }
    else {
      row += key === 'ArrowUp' ? -1 : key === 'PageUp' ? -10 : key === 'PageDown' ? 10 : 1
      while (row < 0 && page > 0) { page -= 1; row += current.current.pages[page]!.count }
      while (row >= current.current.pages[page]!.count && page + 1 < current.current.pages.length) { row -= current.current.pages[page]!.count; page += 1 }
      row = Math.max(0, Math.min(row, current.current.pages[page]!.count - 1))
    }
    const target = { page, row }
    keyboard.current = target
    const viewport = viewportRef.current
    const edges = offsets()
    if (viewport && (edges[page]! < viewport.scrollTop || edges[page + 1]! > viewport.scrollTop + viewport.clientHeight)) {
      viewport.scrollTop = edges[page]!
    }
    const records = await read(page)
    if (epoch !== generation.current || keyboard.current !== target) return undefined
    sync()
    if (page === current.current.pages.length - 1 && row === (records?.length ?? 0) - 1) loadMore()
    return records?.[row]
  }
  return { ...state, onScroll: sync, loadMore, refresh, pageRef, activate, navigate,
    records: [...state.cache].sort(([a], [b]) => a - b).flatMap(([, records]) => records) }
}
