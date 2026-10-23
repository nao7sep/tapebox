// @vitest-environment jsdom
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordsPage, RecordsQuery, RecordSummary } from '@shared/records'
import { useRecordPages } from '@renderer/records/useRecordPages'
import { recordKey } from '@renderer/records/record-format'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: invoke }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const filters: Omit<RecordsQuery, 'after'> = { session: null, kind: null, level: null, tapeId: null, search: '' }
const time = '2026-10-23T00:00:00.000Z'
const rows: RecordSummary[] = Array.from({ length: 24 }, (_, index) => ({
  kind: index < 2 ? 'ytdlp-run' : 'log', id: 24 - index, session: time, time,
  level: 'info', title: `row ${index}`, text: null, tapeId: null,
}))
const onFailure = vi.fn()
let root: Root | null
let host: HTMLDivElement
let viewport: HTMLDivElement
let api: ReturnType<typeof useRecordPages>
let top = 0
let height = 100
const observers = new Set<Observer>()
class Observer {
  nodes = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
  observe(node: Element) { this.nodes.add(node) }
  unobserve(node: Element) { this.nodes.delete(node) }
  disconnect() { this.nodes.clear(); observers.delete(this) }
}
function Harness({ query = filters }: { query?: Omit<RecordsQuery, 'after'> }) {
  const ref = useRef<HTMLDivElement | null>(null)
  api = useRecordPages(query, ref, onFailure)
  return createElement('div', { ref, 'data-viewport': '', onScroll: api.onScroll },
    api.pages.map((page, index) => api.cache.has(index)
      ? createElement('div', { key: index, ref: api.pageRef(index), 'data-record-page': index },
        api.cache.get(index)!.map((record) => createElement('div', { key: recordKey(record), 'data-row': recordKey(record) }, record.title)))
      : createElement('div', { key: index, 'data-spacer': index, style: { height: page.height } })),
  )
}
async function render(query = filters) {
  await act(async () => root!.render(createElement(Harness, { query })))
  viewport = host.querySelector('[data-viewport]')!
}
function deferred() {
  let resolve!: (page: RecordsPage) => void
  const promise = new Promise<RecordsPage>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function scroll(value: number) {
  await act(async () => { top = value; viewport.dispatchEvent(new Event('scroll')) })
}
async function visitEnd() {
  await scroll(Math.max(0, api.pages.reduce((sum, page) => sum + page.height, 0) - height))
}
function backend(_channel: string, query: RecordsQuery): Promise<RecordsPage> {
  const index = query.after ? rows.findIndex((row) => row.time === query.after!.time && row.kind === query.after!.kind && row.id === query.after!.id) + 1 : 0
  return Promise.resolve({ records: rows.slice(index, index + 2), more: index + 2 < rows.length })
}
beforeEach(() => {
  top = 0; height = 100
  invoke.mockReset().mockImplementation(backend)
  onFailure.mockReset()
  vi.stubGlobal('ResizeObserver', Observer)
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: { configurable: true, get() { return top }, set(value: number) { top = value } },
    clientHeight: { configurable: true, get() { return height } },
    scrollHeight: { configurable: true, get() { return api?.pages.reduce((sum, page) => sum + page.height, 0) ?? 0 } },
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host.remove()
  vi.unstubAllGlobals()
  for (const key of ['scrollTop', 'clientHeight', 'scrollHeight']) Reflect.deleteProperty(HTMLElement.prototype, key)
})

describe('bounded Records cursor pages', () => {
  it('retains compact history but bounds cached and mounted rows, then reloads in either direction', async () => {
    await render()
    for (let index = 0; index < 14; index++) await visitEnd()
    expect(api.pages).toHaveLength(12)
    expect(api.cache.size).toBeLessThanOrEqual(4)
    expect(host.querySelectorAll('[data-row]').length).toBeLessThanOrEqual(8)
    expect(host.querySelectorAll('[data-spacer]').length).toBeGreaterThan(0)
    const extent = api.pages.reduce((sum, page) => sum + page.height, 0)
    const reads = invoke.mock.calls.length
    await scroll(0)
    expect(api.pages).toHaveLength(12)
    expect(api.cache.has(0)).toBe(true)
    expect(api.cache.has(11)).toBe(false)
    expect(invoke.mock.calls.length).toBeGreaterThan(reads)
    expect(host.textContent).toContain('row 0')
    expect(api.pages.reduce((sum, page) => sum + page.height, 0)).toBe(extent)
    await visitEnd()
    expect(api.cache.has(11)).toBe(true)
    expect(api.cache.has(0)).toBe(false)
    expect(host.textContent).toContain('row 23')
  })

  it('derives its cache window from the current viewport and reduces it after a resize', async () => {
    await render()
    for (let index = 0; index < 14; index++) await visitEnd()
    height = 700
    await scroll(0)
    expect(api.cache.size).toBeGreaterThan(4)
    expect(api.cache.size).toBeLessThanOrEqual(6)
    expect(host.querySelectorAll('[data-row]').length).toBe(api.cache.size * 2)
    height = 100
    await act(async () => {
      for (const observer of observers) if (observer.nodes.has(viewport)) observer.callback([], observer as unknown as ResizeObserver)
    })
    expect(api.cache.size).toBeLessThanOrEqual(3)
  })

  it('records natural measured page heights and keeps them in evicted spacers', async () => {
    await render()
    const first = host.querySelector('[data-record-page="0"]')!
    await act(async () => {
      for (const observer of observers) if (observer.nodes.has(first)) {
        observer.callback([{ target: first, borderBoxSize: [{ blockSize: 347 }] } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver)
      }
    })
    expect(api.pages[0]!.height).toBe(347)
    for (let index = 0; index < 8; index++) await visitEnd()
    expect(api.cache.has(0)).toBe(false)
    expect(host.querySelector<HTMLElement>('[data-spacer="0"]')!.style.height).toBe('347px')
  })

  it('keeps End on the last real page after an empty terminal page', async () => {
    invoke.mockResolvedValueOnce({ records: rows.slice(0, 2), more: true })
      .mockResolvedValue({ records: [], more: false })
    await render()
    expect(api.pages).toHaveLength(1)
    let end: RecordSummary | undefined
    await act(async () => { end = await api.navigate('End') })
    expect(end).toEqual(rows[1])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('uses the complete cursor including kind and id when timestamp values tie', async () => {
    await render()
    await visitEnd()
    const queries = invoke.mock.calls.map((call) => call[1] as RecordsQuery)
    expect(queries[1]!.after).toEqual({ time, kind: 'ytdlp-run', id: 23 })
    expect(queries[2]!.after).toEqual({ time, kind: 'log', id: 21 })
    expect(new Set(api.records.map(recordKey)).size).toBe(api.records.length)
  })

  it('bridges unloaded keyboard pages and returns Home/End to visited boundaries', async () => {
    await render()
    for (let index = 0; index < 8; index++) await visitEnd()
    expect(api.cache.has(0)).toBe(false)
    let home: RecordSummary | undefined
    await act(async () => { home = await api.navigate('Home') })
    expect(home).toEqual(rows[0])
    expect(top).toBe(0)
    api.activate(home!)
    let next: RecordSummary | undefined
    await act(async () => { next = await api.navigate('ArrowDown') })
    expect(next).toEqual(rows[1])
    api.activate(next!)
    await act(async () => { next = await api.navigate('ArrowDown') })
    expect(next).toEqual(rows[2])
    const lastVisited = api.pages.length - 1
    let end: RecordSummary | undefined
    await act(async () => { end = await api.navigate('End') })
    expect(end).toEqual(rows[lastVisited * 2 + 1])
  })

  it('invalidates cursor history on live refresh and ignores an older pending reload', async () => {
    await render()
    for (let index = 0; index < 7; index++) await visitEnd()
    const pending = deferred()
    invoke.mockImplementationOnce(() => pending.promise)
    await scroll(0)
    const fresh = { ...rows[0]!, id: 100, title: 'newest' }
    invoke.mockResolvedValue({ records: [fresh], more: false })
    await act(async () => api.refresh())
    await act(async () => pending.resolve({ records: rows.slice(0, 2), more: true }))
    expect(api.pages).toHaveLength(1)
    expect(api.records).toEqual([fresh])
    expect(host.textContent).toBe('newest')
  })

  it('does not start reads from retired page boundaries while live refresh is pending', async () => {
    await render()
    const pending = deferred()
    invoke.mockImplementationOnce(() => pending.promise)
    let refresh!: Promise<void>
    await act(async () => { refresh = api.refresh() })
    const reads = invoke.mock.calls.length
    await act(async () => { api.loadMore(); api.onScroll() })
    expect(invoke).toHaveBeenCalledTimes(reads)
    await act(async () => pending.resolve({ records: [rows[0]!], more: false }))
    await refresh
    expect(api.pages).toHaveLength(1)
    expect(api.records).toEqual([rows[0]])
  })

  it('drops late results from a previous filter generation', async () => {
    const pending = deferred()
    invoke.mockImplementationOnce(() => pending.promise)
    await render()
    const match = { ...rows[0]!, title: 'filtered' }
    invoke.mockResolvedValue({ records: [match], more: false })
    await render({ ...filters, search: 'filtered' })
    await act(async () => pending.resolve({ records: rows, more: false }))
    expect(api.records).toEqual([match])
    expect(api.pages).toHaveLength(1)
    expect(top).toBe(0)
  })
})
