// @vitest-environment jsdom
import { IpcCallError } from '@shared/ipc-reply'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcCalls } from '@shared/ipc-contract'
import { LAYOUT_BOUNDS, RECORDS_DETAIL_MIN_WIDTH, RECORDS_FILTERS_HEIGHT, defaultLayout } from '@shared/layout'
import type { RecordDetail, RecordsPage, RecordsQuery, RecordSummary } from '@shared/records'

const bridge = vi.hoisted(() => {
  const value = {
    languageEnvironment: { preference: 'en', systemLanguage: 'en', systemLocale: 'en-US' },
    isDebugEnabled: false,
    log: () => {},
  }
  Object.defineProperty(window, 'tapebox', { configurable: true, value })
  return value
})
const { ipcInvoke, ipcOn, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), ipcOn: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { RecordsApp, RecordsWindow } from '@renderer/records/RecordsWindow'
import { loadAllCatalogues } from '../../helpers/i18n'

const CATALOGUES = await loadAllCatalogues()
void bridge

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = '2026-10-04T08:00:00.000Z'

const call: RecordSummary = {
  kind: 'ai-call', id: 4, session: SESSION, time: '2026-10-04T08:01:00.000Z', level: 'error',
  title: 'gpt-x', text: 'https://api.openai.com/v1', tapeId: 't1',
}
const line: RecordSummary = {
  kind: 'log', id: 9, session: SESSION, time: '2026-10-04T08:00:30.000Z', level: 'warn',
  title: 'download stalled', text: null, tapeId: 't1',
}
const newer: RecordSummary = {
  kind: 'log', id: 12, session: SESSION, time: '2026-10-04T08:02:00.000Z', level: 'info',
  title: 'arrived while open', text: null, tapeId: null,
}
const callDetail: RecordDetail = {
  kind: 'ai-call', id: 4, session: SESSION, tapeId: 't1', startedAt: '2026-10-04T08:01:00.000Z',
  endedAt: '2026-10-04T08:01:02.500Z', elapsedMs: null, level: 'error', endpoint: 'https://api.openai.com/v1', model: 'gpt-x',
  request: JSON.stringify({ input: 'say hello', apiKey: 'sk-test' }), status: 429, response: 'null',
  error: JSON.stringify({ name: 'RateLimitError', message: 'quota' }),
}
const runDetail: RecordDetail = {
  kind: 'ytdlp-run', id: 2, session: SESSION, tapeId: null, scanId: 's1', run: 'scan', url: 'https://example.com/list',
  args: JSON.stringify(['--flat-playlist']), startedAt: '2026-10-04T08:00:00.000Z', endedAt: '2026-10-04T08:00:01.000Z', elapsedMs: null,
  level: 'error', exitCode: 1, signal: null, stopReason: null, stdout: 'partial', stderr: 'ERROR: boom', stdoutMore: false, stderrMore: false, outputStatus: 'complete',
}

type Handler = (req: unknown) => Promise<unknown>
const replies = new Map<keyof IpcCalls, Handler>()
const listeners = new Map<string, (payload: unknown) => void>()

const pageCalls = () => ipcInvoke.mock.calls.filter(([channel]) => channel === 'records:page')
const lastQuery = (): RecordsQuery => pageCalls().at(-1)![1] as RecordsQuery
const detailCalls = () => ipcInvoke.mock.calls.filter(([channel]) => channel === 'records:detail')
const sourceCalls = () => ipcInvoke.mock.calls.filter(([channel]) => channel === 'records:sources')
const widthSaves = () => ipcInvoke.mock.calls.filter(([channel]) => channel === 'layout:update')

// Answers each channel's calls in turn; the last answer repeats.
function answer(channel: keyof IpcCalls, ...values: Array<unknown | (() => Promise<unknown>)>): void {
  const queue = [...values]
  replies.set(channel, async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return typeof next === 'function' ? (next as () => Promise<unknown>)() : next
  })
}

// jsdom lays nothing out, so the list's scroll box and the window's width are
// set here. By default the list is scrolled to the top and far from its end.
const box = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 }
const resizeCallbacks = new Set<() => void>()
class TestResizeObserver {
  private readonly notify: () => void
  constructor(callback: ResizeObserverCallback) { this.notify = () => callback([], this as unknown as ResizeObserver) }
  observe(): void { resizeCallbacks.add(this.notify) }
  unobserve(): void {}
  disconnect(): void { resizeCallbacks.delete(this.notify) }
}
const isScroll = (element: HTMLElement) => element.hasAttribute('data-records-scroll')

let root: Root | null = null

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  ipcInvoke.mockReset()
  ipcInvoke.mockImplementation((channel: keyof IpcCalls, req: unknown) => {
    const reply = replies.get(channel)
    if (!reply) return Promise.reject(new Error(`no reply for ${channel}`))
    return reply(req)
  })
  ipcOn.mockReset()
  ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
    listeners.set(channel, listener)
    return () => listeners.delete(channel)
  })
  logError.mockReset()
  replies.clear()
  listeners.clear()
  answer('records:page', { records: [call, line], more: false } satisfies RecordsPage)
  answer('records:detail', callDetail)
  answer('records:sources', {
    currentSession: SESSION,
    sessions: [SESSION, '2026-10-03T08:00:00.000Z'],
    tapes: [{ tapeId: 't1', name: 'A walk in the park' }],
  })
  replies.set('layout:update', async (patch) => ({ ...defaultLayout, ...(patch as object) }))
  answer('layout:get', { ...defaultLayout, recordsListWidth: 512 })
  answer('settings:get', { timeZone: 'system', uiFontFamily: '' })
  Object.assign(box, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 })
  resizeCallbacks.clear()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return isScroll(this) ? box.scrollTop : 0 },
      set(this: HTMLElement, value: number) { if (isScroll(this)) box.scrollTop = value },
    },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.scrollHeight : 0 } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.clientHeight : 0 } },
    clientWidth: { configurable: true, get(this: HTMLElement) { return this.tagName === 'MAIN' ? box.shellWidth : 0 } },
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const name of ['scrollTop', 'scrollHeight', 'clientHeight', 'clientWidth']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

async function mount(element = createElement(RecordsWindow, { initialListWidth: LAYOUT_BOUNDS.recordsListWidth.default, timeZone: 'UTC' })) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
const titles = () => options().map((option) => option.querySelector('[data-record-title]')?.textContent)
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]')!
const scrollBox = () => document.querySelector<HTMLElement>('[data-records-scroll]')!
const listPane = () => document.querySelector<HTMLElement>('main > section')!
const scrollTo = async (top: number, events = 1) => {
  await act(async () => {
    box.scrollTop = top
    for (let index = 0; index < events; index++) scrollBox().dispatchEvent(new Event('scroll'))
  })
}
const press = async (key: string) => {
  await act(async () => {
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}
const signal = async () => {
  await act(async () => listeners.get('records:changed')!(null))
}
const cursorOf = (record: RecordSummary) => ({ time: record.time, kind: record.kind, id: record.id })
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('RecordsWindow', () => {
  it('lists the records newest first, with every filter off and nothing selected', async () => {
    await mount()

    expect(titles()).toEqual(['gpt-x', 'download stalled'])
    expect(lastQuery()).toEqual({ session: null, kind: null, level: null, tapeId: null, search: '', after: null })
    expect(document.body.textContent).toContain('Select a record to see everything it holds.')
    expect(listbox().tabIndex).toBe(0)
    expect(options().every((option) => option.getAttribute('aria-selected') === 'false')).toBe(true)
    expect(Array.from(document.querySelectorAll('select')).map((select) => select.value)).toEqual(['', '', '', ''])
    // A read that succeeds logs nothing, so it never signals a read of its own.
    expect(logError).not.toHaveBeenCalled()
  })

  it('shows everything a selected AI call holds, leaving out a response that is null', async () => {
    await mount()
    await act(async () => options()[0]!.click())

    expect(ipcInvoke).toHaveBeenCalledWith('records:detail', { kind: 'ai-call', id: 4 })
    const blocks = Array.from(document.querySelectorAll('[data-records-block]')).map((block) => [
      block.querySelector('h3')?.textContent,
      block.querySelector('pre')?.textContent,
    ])
    expect(blocks).toEqual([
      ['Request', JSON.stringify({ input: 'say hello', apiKey: 'sk-test' }, null, 2)],
      ['Error', JSON.stringify({ name: 'RateLimitError', message: 'quota' }, null, 2)],
    ])
    const body = document.querySelector('[data-records-detail]')!.textContent!
    expect(body).toContain('A walk in the park')
    expect(body).toContain('t1')
    expect(body).toContain('429')
    expect(body).toContain('2.500')
    expect(body).toContain('(this launch)')
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(listbox().getAttribute('aria-activedescendant')).toBe(options()[0]!.id)
  })

  it('shows a run whole: its arguments, both outputs, and an exit that failed as an error', async () => {
    answer('records:page', { records: [{ ...call, kind: 'ytdlp-run', id: 2, title: 'yt-dlp scan', level: 'error' }], more: false })
    answer('records:detail', runDetail)
    await mount()
    await act(async () => options()[0]!.click())

    const blocks = Array.from(document.querySelectorAll('[data-records-block]')).map((block) => block.querySelector('pre')?.textContent)
    expect(blocks).toEqual([JSON.stringify(['--flat-playlist'], null, 2), 'partial', 'ERROR: boom'])
    const body = document.querySelector('[data-records-detail]')!.textContent!
    expect(body).toContain('https://example.com/list')
    expect(body).toContain('s1')
    expect(document.querySelector('h2')!.textContent).toBe('yt-dlp scan')
  })

  it('shows a run the user cancelled as a warning, with why it ended early', async () => {
    answer('records:page', { records: [{ ...call, kind: 'ytdlp-run', id: 2, title: 'yt-dlp scan', level: 'warn' }], more: false })
    answer('records:detail', { ...runDetail, level: 'warn', exitCode: null, signal: 'SIGTERM', stopReason: 'cancel' })
    await mount()
    await act(async () => options()[0]!.click())

    const header = document.querySelector('h2')!.parentElement!.textContent!
    expect(header).toContain('Warning')
    expect(header).not.toContain('Error')
    const body = document.querySelector('[data-records-detail]')!.textContent!
    expect(body).toContain('Ended early')
    expect(body).toContain('Cancelled')
    expect(body).toContain('SIGTERM')
  })

  it.each(['complete', 'incomplete', 'unknown'] as const)('shows output completeness independently of run success: %s', async (outputStatus) => {
    answer('records:page', { records: [{ ...call, kind: 'ytdlp-run', id: 2, title: 'yt-dlp scan', level: 'info' }], more: false })
    answer('records:detail', { ...runDetail, level: 'info', exitCode: 0, outputStatus })
    await mount()
    await act(async () => options()[0]!.click())
    const detail = document.querySelector('[data-records-detail]')!
    expect(detail.textContent!.includes('Some output was not retained in Records.')).toBe(outputStatus === 'incomplete')
    expect(detail.textContent!.includes('Output completeness is unknown for this run.')).toBe(outputStatus === 'unknown')
    expect(document.querySelector('h2')!.parentElement!.textContent).not.toContain('Error')
  })

  it('leaves out the blocks of a run that are empty', async () => {
    answer('records:page', { records: [{ ...call, kind: 'ffmpeg-run', id: 3, title: 'ffmpeg probe', level: 'info' }], more: false })
    answer('records:detail', {
      kind: 'ffmpeg-run', id: 3, session: SESSION, tapeId: null, run: 'probe', args: '[]',
      startedAt: runDetail.startedAt, endedAt: runDetail.endedAt, elapsedMs: null, level: 'info', exitCode: 0, signal: null, stopReason: null,
      stdout: '{"streams":[]}', stderr: ' \n', stdoutMore: false, stderrMore: false, outputStatus: 'complete',
    } satisfies RecordDetail)
    await mount()
    await act(async () => options()[0]!.click())

    const blocks = Array.from(document.querySelectorAll('[data-records-block]')).map((block) => block.querySelector('h3')?.textContent)
    expect(blocks).toEqual(['Output'])
  })

  const logDetail = (fields: object): RecordDetail => ({
    kind: 'log', id: 9, session: SESSION, time: line.time, level: 'warn', message: 'download stalled', tapeId: 't1',
    fields: JSON.stringify(fields),
  })
  const logBlocks = async (fields: object) => {
    answer('records:detail', logDetail(fields))
    await mount()
    await act(async () => options()[1]!.click())
    return Array.from(document.querySelectorAll('[data-records-block]')).map((block) => [
      block.querySelector('h3')?.textContent,
      block.querySelector('pre')?.textContent,
    ])
  }

  it("shows a log line's fields without the tape the pane already shows", async () => {
    expect(await logBlocks({ tapeId: 't1', bytes: 5 })).toEqual([['Details', JSON.stringify({ bytes: 5 }, null, 2)]])
    expect(document.querySelector('[data-records-detail]')!.textContent).toContain('t1')
  })

  it('leaves out the Details of a log line with nothing more to say', async () => {
    expect(await logBlocks({ tapeId: 't1' })).toEqual([])
  })

  // A row's title is identifying text on one line; the detail heading shows it whole.
  // The window minimum reserves the filter band's height, which the band takes.
  it('gives the filter band the height the window minimum reserves', async () => {
    await mount()
    expect(document.querySelector<HTMLElement>('input[type="search"]')!.parentElement!.style.height).toBe(`${RECORDS_FILTERS_HEIGHT}px`)
  })

  it('shortens a long title in its row', async () => {
    await logBlocks({})
    expect(document.querySelector('[data-record-title]')!.className.split(/\s+/)).toContain('truncate')
  })

  it('moves the selection with the arrow keys, keeping focus on the list', async () => {
    await mount()
    await act(async () => listbox().focus())
    await press('ArrowDown')
    await press('ArrowDown')

    expect(document.activeElement).toBe(listbox())
    expect(ipcInvoke).toHaveBeenLastCalledWith('records:detail', { kind: 'log', id: 9 })
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(options()[1]!.classList.contains('listbox-item')).toBe(true)
    await act(async () => options()[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(listbox())
    await press('ArrowUp')
    expect(ipcInvoke).toHaveBeenLastCalledWith('records:detail', { kind: 'ai-call', id: 4 })
  })

  it('reads again with each filter, and searches once typing pauses', async () => {
    await mount()
    const selects = Array.from(document.querySelectorAll('select'))
    expect(Array.from(selects[0]!.options).map((option) => option.textContent)).toEqual([
      'All launches',
      expect.stringContaining('(this launch)'),
      expect.not.stringContaining('(this launch)'),
    ])
    expect(Array.from(selects[1]!.options).map((option) => option.textContent)).toEqual(['All tapes', 'A walk in the park'])
    expect(Array.from(selects[2]!.options).map((option) => option.textContent)).toEqual([
      'All kinds', 'Log line', 'AI call', 'yt-dlp run', 'ffmpeg run',
    ])

    await choose(selects[0]!, SESSION)
    await choose(selects[1]!, 't1')
    await choose(selects[2]!, 'ai-call')
    await choose(selects[3]!, 'error')
    expect(lastQuery()).toEqual({ session: SESSION, kind: 'ai-call', level: 'error', tapeId: 't1', search: '', after: null })

    vi.useFakeTimers()
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(search, 'quota')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(lastQuery().search).toBe('')
    await act(async () => vi.advanceTimersByTime(300))
    expect(lastQuery().search).toBe('quota')
  })

  it('offers Warnings and errors first among the levels', async () => {
    await mount()
    const level = document.querySelectorAll('select')[3]!
    expect(Array.from(level.options).map((option) => option.textContent)).toEqual([
      'All levels', 'Warnings and errors', 'Error', 'Warning', 'Info', 'Debug',
    ])
  })

  it('shows a loading note while the first page is read, then the rows, and an empty note for no match', async () => {
    const first = deferred<RecordsPage>()
    answer('records:page', () => first.promise, { records: [], more: false })
    await mount()

    expect(document.body.textContent).toContain('Loading records…')
    expect(document.body.textContent).not.toContain('No records match these filters.')
    expect(options()).toHaveLength(0)

    await act(async () => first.resolve({ records: [call, line], more: false }))
    expect(options()).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Loading records…')

    await choose(document.querySelectorAll('select')[3]!, 'debug')
    expect(options()).toHaveLength(0)
    expect(document.body.textContent).toContain('No records match these filters.')
  })

  it('has no Refresh or Show more button', async () => {
    answer('records:page', { records: [call], more: true }, () => new Promise(() => {}))
    await mount()
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })

  it('reads the next page from the last row once the list is scrolled near its end', async () => {
    answer('records:page', { records: [call], more: true }, { records: [line], more: false })
    await mount()
    expect(pageCalls()).toHaveLength(1)

    await scrollTo(700)

    expect(pageCalls()).toHaveLength(2)
    expect(lastQuery().after).toEqual(cursorOf(call))
    expect(titles()).toEqual(['gpt-x', 'download stalled'])
  })

  it('reads the next page when the keyboard reaches the last row', async () => {
    answer('records:page', { records: [call, line], more: true }, { records: [], more: false })
    await mount()
    await act(async () => listbox().focus())
    await press('End')

    expect(pageCalls()).toHaveLength(2)
    expect(lastQuery().after).toEqual(cursorOf(line))
    expect(document.activeElement).toBe(listbox())
  })

  it('makes one request for two scroll events together', async () => {
    answer('records:page', { records: [call, line], more: true }, () => new Promise(() => {}))
    await mount()

    await scrollTo(800, 2)

    expect(pageCalls()).toHaveLength(2)
    expect(options()).toHaveLength(2)
    expect(document.body.textContent).toContain('Loading records…')
  })

  it('reads the next page by itself while a page does not fill the list', async () => {
    box.scrollHeight = 150
    answer('records:page', { records: [call], more: true }, { records: [line], more: false })
    await mount()

    expect(pageCalls()).toHaveLength(2)
    expect(titles()).toEqual(['gpt-x', 'download stalled'])
  })

  it("keeps a failed page's note at the end, and reads it again when the end is reached again", async () => {
    answer(
      'records:page',
      { records: [call], more: true },
      () => Promise.reject(new Error('busy')),
      { records: [line], more: false },
    )
    await mount()

    await scrollTo(700)
    expect(document.body.textContent).toContain('The records could not be read.')
    expect(options()).toHaveLength(1)
    expect(pageCalls()).toHaveLength(2)

    await scrollTo(750)
    expect(pageCalls()).toHaveLength(3)
    expect(lastQuery().after).toEqual(cursorOf(call))
    expect(titles()).toEqual(['gpt-x', 'download stalled'])
    expect(document.body.textContent).not.toContain('The records could not be read.')
  })

  it('re-reads the newest page once for a burst of new records while at the top, keeping the rows shown', async () => {
    await mount()
    vi.useFakeTimers()
    const next = deferred<RecordsPage>()
    answer('records:page', () => next.promise)

    await signal()
    await signal()
    await signal()
    await act(async () => vi.advanceTimersByTime(1000))

    expect(pageCalls()).toHaveLength(2)
    expect(lastQuery()).toEqual({ session: null, kind: null, level: null, tapeId: null, search: '', after: null })
    expect(sourceCalls()).toHaveLength(2)
    expect(options()).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Loading records…')

    await act(async () => next.resolve({ records: [newer, call, line], more: false }))
    expect(titles()).toEqual(['arrived while open', 'gpt-x', 'download stalled'])
  })

  it('leaves the list alone while scrolled down, and shows new records once back at the top', async () => {
    await mount()
    await scrollTo(300)
    vi.useFakeTimers()
    answer('records:page', { records: [newer, call, line], more: false })

    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(pageCalls()).toHaveLength(1)
    expect(options()).toHaveLength(2)

    await scrollTo(0)
    expect(pageCalls()).toHaveLength(2)
    expect(titles()).toEqual(['arrived while open', 'gpt-x', 'download stalled'])
  })

  it('keeps the selected record selected through an update', async () => {
    await mount()
    await act(async () => options()[1]!.click())
    vi.useFakeTimers()
    answer('records:page', { records: [newer, call, line], more: false })

    await signal()
    await act(async () => vi.advanceTimersByTime(1000))

    expect(options()).toHaveLength(3)
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true')
    expect(detailCalls()).toHaveLength(1)
  })

  it('stops reading on new-record signals after a failed read, so a logged failure cannot start the next read', async () => {
    await mount()
    vi.useFakeTimers()
    answer('records:page', () => Promise.reject(new Error('busy')))

    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(pageCalls()).toHaveLength(2)

    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(pageCalls()).toHaveLength(2)
    expect(options()).toHaveLength(2)
    expect(logError).toHaveBeenCalledOnce()
  })

  it('publishes a slow refresh before coalescing further changes into one follow-up', async () => {
    await mount()
    vi.useFakeTimers()
    const first = deferred<RecordsPage>()
    const second = deferred<RecordsPage>()
    answer('records:page', () => first.promise, () => second.promise)
    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    for (let index = 0; index < 3; index++) {
      await signal()
      await act(async () => vi.advanceTimersByTime(1000))
    }
    expect(pageCalls()).toHaveLength(2)
    expect(sourceCalls()).toHaveLength(2)
    await act(async () => first.resolve({ records: [newer], more: false }))
    expect(titles()).toEqual(['arrived while open'])
    await act(async () => vi.advanceTimersByTime(1000))
    expect(pageCalls()).toHaveLength(3)
    await act(async () => second.resolve({ records: [newer, call], more: false }))
    expect(titles()).toEqual(['arrived while open', 'gpt-x'])
  })

  it('allows a slow source response to publish before another live refresh', async () => {
    await mount()
    vi.useFakeTimers()
    const sources = deferred<{ currentSession: string; sessions: string[]; tapes: { tapeId: string; name: string }[] }>()
    answer('records:sources', () => sources.promise)
    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    await signal()
    await act(async () => vi.advanceTimersByTime(3000))
    expect(sourceCalls()).toHaveLength(2)
    await act(async () => sources.resolve({ currentSession: SESSION, sessions: [SESSION], tapes: [{ tapeId: 'new', name: 'New source' }] }))
    expect(document.querySelectorAll('select')[1]!.textContent).toContain('New source')
  })

  it('retries a failed read while scrolled down without leaving the failure stuck', async () => {
    await mount()
    await scrollTo(300)
    answer('records:sources', () => Promise.reject(new Error('busy')), { currentSession: SESSION, sessions: [SESSION], tapes: [] })
    vi.useFakeTimers()
    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
    await act(async () => retry.click())
    expect(box.scrollTop).toBe(0)
    expect(document.body.textContent).not.toContain('The records could not be read.')
  })

  it('retains one dirty signal while hidden and catches up when visible', async () => {
    await mount()
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await signal()
    await signal()
    await act(async () => vi.advanceTimersByTime(5000))
    expect(pageCalls()).toHaveLength(1)
    expect(sourceCalls()).toHaveLength(1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(pageCalls()).toHaveLength(2)
    expect(sourceCalls()).toHaveLength(2)
  })

  it.each(['records:page', 'records:sources'] as const)('shows and retries a live %s failure without duplicating main diagnostics', async (channel) => {
    await mount()
    vi.useFakeTimers()
    const fallback = channel === 'records:page'
      ? { records: [newer, call], more: false }
      : { currentSession: SESSION, sessions: [SESSION], tapes: [] }
    answer(channel, () => Promise.reject(new IpcCallError(channel, { code: 'internal', userMessage: null })), fallback)
    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(document.body.textContent).toContain('The records could not be read.')
    expect(logError).not.toHaveBeenCalled()
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
    await act(async () => retry.click())
    expect(document.body.textContent).not.toContain('The records could not be read.')
  })

  it('stops listening for new records when it closes', async () => {
    await mount()
    expect(listeners.has('records:changed')).toBe(true)
    await act(async () => root!.unmount())
    root = null
    expect(listeners.has('records:changed')).toBe(false)
  })

  it('saves the list width once, when a drag ends, within the pane bounds', async () => {
    await mount()
    const splitter = document.querySelector<HTMLElement>('[role="separator"]')!

    await act(async () => {
      splitter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 }))
    })
    expect(widthSaves()).toHaveLength(0)
    expect(listPane().style.width).toBe(`${LAYOUT_BOUNDS.recordsListWidth.max}px`)

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(widthSaves()).toEqual([['layout:update', { recordsListWidth: LAYOUT_BOUNDS.recordsListWidth.max }]])
    expect(listPane().style.width).toBe(`${LAYOUT_BOUNDS.recordsListWidth.max}px`)
  })

  it('narrows the list when the window narrows, saving nothing', async () => {
    await mount()
    expect(listPane().style.width).toBe(`${LAYOUT_BOUNDS.recordsListWidth.default}px`)

    await act(async () => {
      box.shellWidth = RECORDS_DETAIL_MIN_WIDTH + LAYOUT_BOUNDS.recordsListWidth.min
      for (const callback of resizeCallbacks) callback()
    })

    expect(listPane().style.width).toBe(`${LAYOUT_BOUNDS.recordsListWidth.min}px`)
    expect(widthSaves()).toHaveLength(0)
  })

  it('says when the records cannot be read, without the raw error', async () => {
    answer('records:page', () => Promise.reject(new Error('SQLITE_CORRUPT /Users/someone/.tapebox/records.sqlite3')))
    await mount()

    expect(document.body.textContent).toContain('The records could not be read.')
    expect(document.body.textContent).not.toContain('SQLITE_CORRUPT')
    expect(logError).toHaveBeenCalled()
  })

  it('holds a newest page that arrives after the list left the top until it is back there', async () => {
    await mount()
    vi.useFakeTimers()
    const late = deferred<RecordsPage>()
    answer('records:page', () => late.promise, { records: [newer, call, line], more: false })

    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(pageCalls()).toHaveLength(2)
    await scrollTo(300)
    await act(async () => late.resolve({ records: [newer, call, line], more: false }))
    expect(titles()).toEqual(['gpt-x', 'download stalled'])

    await scrollTo(0)
    expect(pageCalls()).toHaveLength(3)
    expect(titles()).toEqual(['arrived while open', 'gpt-x', 'download stalled'])
  })

  it('keeps older pages already loaded when the newest page arrives', async () => {
    answer('records:page', { records: [call], more: true }, { records: [line], more: false })
    box.scrollHeight = 200
    await mount()
    expect(titles()).toEqual(['gpt-x', 'download stalled'])
    box.scrollHeight = 1000
    vi.useFakeTimers()
    answer('records:page', { records: [newer, call], more: true })

    await signal()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(titles()).toEqual(['arrived while open', 'gpt-x', 'download stalled'])
  })

  it('pages through 10,000 records while new ones arrive, moving nothing while scrolled down', async () => {
    const ROW = 40
    let sequence = 0
    const record = (): RecordSummary => {
      sequence += 1
      return {
        kind: 'log', id: sequence, session: SESSION, time: new Date(Date.UTC(2026, 9, 4) + sequence * 1000).toISOString(),
        level: 'info', title: `record ${sequence}`, text: null, tapeId: null,
      }
    }
    // The store, newest first, as the records query orders it, 100 at a time.
    const store: RecordSummary[] = []
    const log = (count: number) => { for (let index = 0; index < count; index++) store.unshift(record()) }
    log(10_000)
    replies.set('records:page', async (req) => {
      const { after } = req as RecordsQuery
      const start = after === null ? 0 : store.findIndex((row) => row.kind === after.kind && row.id === after.id) + 1
      return { records: store.slice(start, start + 100), more: start + 100 < store.length } satisfies RecordsPage
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return isScroll(this) ? (this.querySelector('[role="listbox"]')?.childElementCount ?? 0) * ROW : 0 },
    })
    const arrive = async (count: number) => {
      for (let index = 0; index < count; index++) {
        log(1)
        await signal()
        await act(async () => vi.advanceTimersByTime(333))
      }
      await act(async () => vi.advanceTimersByTime(1000))
    }

    await mount()
    vi.useFakeTimers()
    expect(titles()).toEqual(store.slice(0, 100).map((row) => row.title))

    // At the top, new records appear at the top on their own.
    await arrive(3)
    expect(titles().slice(0, 4)).toEqual(store.slice(0, 4).map((row) => row.title))

    // Scrolled down with a record selected, new records move nothing.
    await scrollTo(1200)
    await act(async () => options()[31]!.click())
    const held = { titles: titles(), top: box.scrollTop, selected: options()[31]!.dataset.recordKey }
    const reads = pageCalls().length
    await arrive(5)
    expect(titles()).toEqual(held.titles)
    expect(box.scrollTop).toBe(held.top)
    expect(pageCalls()).toHaveLength(reads)

    // Back at the top they are there, and loaded rows and the selection stay.
    await scrollTo(0)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(titles().slice(0, 9)).toEqual(store.slice(0, 9).map((row) => row.title))
    expect(titles().length).toBeGreaterThanOrEqual(held.titles.length + 5)
    const selected = options().find((option) => option.getAttribute('aria-selected') === 'true')
    expect(selected?.dataset.recordKey).toBe(held.selected)

    // Reaching the end again and again loads every record once, in order,
    // while records keep arriving out of sight.
    const lastTitle = () => listbox().lastElementChild?.querySelector('[data-record-title]')?.textContent
    let step = 0
    while (lastTitle() !== 'record 1') {
      const height = listbox().childElementCount * ROW
      await scrollTo(height - box.clientHeight)
      if (++step % 10 === 0) await arrive(1)
    }
    const first = store.findIndex((row) => row.title === titles()[0])
    expect(titles()).toEqual(store.slice(first).map((row) => row.title))
    expect(titles().length).toBeGreaterThan(10_000)
    expect(new Set(titles()).size).toBe(titles().length)
  })

  it('says when a selected record cannot be read', async () => {
    answer('records:detail', null)
    await mount()
    await act(async () => options()[1]!.click())
    expect(document.body.textContent).toContain('This record could not be read.')
  })
})

describe('RecordsApp', () => {
  it('applies its saved font and follows changes and clearing in its own document', async () => {
    answer('settings:get', { timeZone: 'system', uiFontFamily: 'Georgia' })
    await mount(createElement(RecordsApp))
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('Georgia')
    await act(async () => listeners.get('settings:uiFontChanged')!('Arial'))
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('Arial')
    await act(async () => listeners.get('settings:uiFontChanged')!(''))
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('')
  })

  it('keeps a newer font event when the initial settings read arrives late', async () => {
    const settings = deferred<{ timeZone: string; uiFontFamily: string }>()
    answer('settings:get', () => settings.promise)
    await mount(createElement(RecordsApp))
    await act(async () => listeners.get('settings:uiFontChanged')!('Arial'))
    await act(async () => settings.resolve({ timeZone: 'system', uiFontFamily: 'Georgia' }))
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('Arial')
  })

  it('shows localized loading until saved layout and display settings are ready', async () => {
    const layout = deferred<typeof defaultLayout>()
    const settings = deferred<{ timeZone: string; uiFontFamily: string }>()
    answer('layout:get', () => layout.promise)
    answer('settings:get', () => settings.promise)
    await mount(createElement(RecordsApp))
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading…')
    expect(pageCalls()).toHaveLength(0)
    await act(async () => listeners.get('settings:languageChanged')!('ja'))
    expect(document.querySelector('[role="status"]')?.textContent).toBe(CATALOGUES.ja['common.loading'])
    await act(async () => layout.resolve(defaultLayout))
    expect(document.querySelector('[role="status"]')?.textContent).toBe(CATALOGUES.ja['common.loading'])
    expect(pageCalls()).toHaveLength(0)
    await act(async () => settings.resolve({ timeZone: 'UTC', uiFontFamily: '' }))
    expect(document.querySelector('[role="status"]')?.textContent).not.toBe(CATALOGUES.ja['common.loading'])
    expect(pageCalls()).toHaveLength(1)
  })

  it('opens the list at its saved width, and follows a language saved in Settings', async () => {
    await mount(createElement(RecordsApp))

    expect(listPane().style.width).toBe('512px')
    expect(document.title).toBe('Records')

    await act(async () => listeners.get('settings:languageChanged')!('ja'))
    expect(document.title).toBe(CATALOGUES.ja['records.title'])
    expect(document.documentElement.lang).toBe('ja')
  })

  // Times show in the display zone saved in Settings (timestamp-conventions).
  it('shows times in the saved display zone, and follows one saved in Settings', async () => {
    answer('settings:get', { timeZone: 'Asia/Tokyo', uiFontFamily: '' })
    await mount(createElement(RecordsApp))
    // The AI call at 08:01 UTC.
    expect(options()[0]!.textContent).toContain('5:01:00')
    expect(options()[0]!.textContent).toContain('PM')

    await act(async () => listeners.get('settings:timeZoneChanged')!('America/New_York'))
    expect(options()[0]!.textContent).toContain('4:01:00')
    expect(options()[0]!.textContent).toContain('AM')
  })

  it('opens at the default width when the saved one cannot be read', async () => {
    answer('layout:get', () => Promise.reject(new Error('unreadable')))
    await mount(createElement(RecordsApp))
    expect(listPane().style.width).toBe(`${LAYOUT_BOUNDS.recordsListWidth.default}px`)
  })
})
