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
const ROW_HEIGHT = 40
const VIEWPORT_HEIGHT = 100
function Harness({ query = filters }: { query?: Omit<RecordsQuery, 'after'> }) {
  const ref = useRef<HTMLDivElement | null>(null)
  api = useRecordPages(query, ref, onFailure)
  return createElement('div', { ref, 'data-viewport': '', onScroll: api.onScroll },
    api.records.map((record) => createElement('div', { key: recordKey(record) }, record.title)))
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
function backend(_channel: string, query: RecordsQuery): Promise<RecordsPage> {
  const index = query.after ? rows.findIndex((row) => row.time === query.after!.time && row.kind === query.after!.kind && row.id === query.after!.id) + 1 : 0
  return Promise.resolve({ records: rows.slice(index, index + 2), more: index + 2 < rows.length })
}
beforeEach(() => {
  top = 0
  invoke.mockReset().mockImplementation(backend)
  onFailure.mockReset()
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: { configurable: true, get() { return top }, set(value: number) { top = value } },
    clientHeight: { configurable: true, get() { return VIEWPORT_HEIGHT } },
    scrollHeight: { configurable: true, get() { return (api?.records.length ?? 0) * ROW_HEIGHT } },
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host.remove()
  for (const key of ['scrollTop', 'clientHeight', 'scrollHeight']) Reflect.deleteProperty(HTMLElement.prototype, key)
})

describe('Records list pages', () => {
  it('reads the next page with the complete cursor as the end nears, including tied timestamps', async () => {
    await render()
    const queries = invoke.mock.calls.map((call) => call[1] as RecordsQuery)
    expect(queries[0]!.after).toBeNull()
    expect(queries[1]!.after).toEqual({ time, kind: 'ytdlp-run', id: 23 })
    expect(queries[2]!.after).toEqual({ time, kind: 'log', id: 21 })
    const filled = api.records.length
    await scroll(filled * ROW_HEIGHT - VIEWPORT_HEIGHT)
    expect(api.records.length).toBeGreaterThan(filled)
    expect(new Set(api.records.map(recordKey)).size).toBe(api.records.length)
    expect(api.records).toEqual(rows.slice(0, api.records.length))
  })

  it('replaces the shown rows on live refresh and ignores an older pending page', async () => {
    await render()
    const pending = deferred()
    invoke.mockImplementationOnce(() => pending.promise)
    await scroll(api.records.length * ROW_HEIGHT - VIEWPORT_HEIGHT)
    await scroll(0)
    const fresh = { ...rows[0]!, id: 100, title: 'newest' }
    invoke.mockResolvedValue({ records: [fresh], more: false })
    await act(async () => api.refresh())
    await act(async () => pending.resolve({ records: rows.slice(6, 8), more: true }))
    expect(api.records).toEqual([fresh])
    expect(host.textContent).toBe('newest')
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
    expect(top).toBe(0)
  })
})
