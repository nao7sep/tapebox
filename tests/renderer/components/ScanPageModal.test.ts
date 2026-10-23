// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCAN_PAGE_SIZE, type IpcCalls, type ScanResult } from '@shared/ipc-contract'

const { ipcInvoke, stateWrites } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), stateWrites: vi.fn() }))
// A late callback must not dispatch merely because React hides updates after unmount.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useState: <T,>(initial: T | (() => T)) => {
    const [value, setValue] = react.useState(initial)
    const dispatch: React.Dispatch<React.SetStateAction<T>> = (next) => { stateWrites(); setValue(next) }
    return [value, dispatch]
  } }
})
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { ScanPageModal } from '@renderer/components/ScanPageModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
let container: HTMLDivElement
let currentPage: IpcCalls['scan:page']['res']
const ENTRY: ScanResult = {
  sourceId: 'v1', sourceUrl: 'https://example.test/watch?v=1', title: 'A video', durationSeconds: 12,
  uploadDateUtc: null, thumbnailUrl: null, alreadyInLibrary: false, unavailable: null,
}
function page(entries: ScanResult[] = [ENTRY], fields: Partial<IpcCalls['scan:page']['res']> = {}): IpcCalls['scan:page']['res'] {
  return {
    entries: entries.map((entry) => ({ ...entry, selected: !entry.alreadyInLibrary && !entry.unavailable })),
    start: 0, matched: entries.length, total: entries.length,
    selected: entries.filter((entry) => !entry.alreadyInLibrary && !entry.unavailable).length,
    inLibrary: entries.filter((entry) => entry.alreadyInLibrary).length,
    unavailable: entries.filter((entry) => entry.unavailable).length, status: 'running', ...fields,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  ipcInvoke.mockReset()
  stateWrites.mockClear()
  currentPage = page()
  ipcInvoke.mockImplementation(async (channel: string) => {
    if (channel === 'scan:start') return { sessionId: 'S1' }
    if (channel === 'scan:page') return currentPage
    if (channel === 'scan:cancel') currentPage = { ...currentPage, status: 'stopped' }
    if (channel === 'scan:add') return { added: currentPage.selected }
    return undefined
  })
})
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = null }
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})
async function mount(onClose = vi.fn()) {
  root = createRoot(container)
  await act(async () => root!.render(React.createElement(ScanPageModal, { onClose, initialUrl: 'https://example.test/list' })))
  return onClose
}
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Button ${text} not found`)
  return result
}
async function click(text: string) { await act(async () => button(text).click()) }
async function tick(ms = 250) { await act(async () => vi.advanceTimersByTimeAsync(ms)) }
function calls(channel: string) { return ipcInvoke.mock.calls.filter(([name]) => name === channel) }
function searchInput() { return document.querySelector<HTMLInputElement>('input[placeholder="Search title"]')! }
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function scroll(top: number) {
  await act(async () => {
    const list = document.querySelector('ul')!
    list.scrollTop = top
    list.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

describe('ScanPageModal paged results', () => {
  it('renders a viewport from one bounded page and uses server totals and selection', async () => {
    currentPage = page(Array.from({ length: SCAN_PAGE_SIZE }, (_, index) => ({ ...ENTRY, sourceUrl: `https://example.test/${index}`, title: `Video ${index}` })), { total: 3000, matched: 3000, selected: 3000 })
    await mount()
    await click('Scan')
    expect(calls('scan:page')).toEqual([['scan:page', { sessionId: 'S1', search: '', start: 0 }]])
    expect(document.body.textContent).toContain('3,000 found so far')
    expect(button('Add 3,000 tapes')).toBeTruthy()
    expect(document.querySelectorAll('li').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('li').length).toBeLessThan(100)
    currentPage = { ...currentPage, start: 992 }
    await scroll(32 * 1000)
    expect(calls('scan:page').at(-1)).toEqual(['scan:page', { sessionId: 'S1', search: '', start: 992 }])
  })

  it('does not position a cached lower page at earlier virtual rows while upward scrolling waits', async () => {
    currentPage = page([{ ...ENTRY, title: 'Top row' }], { total: 3000, matched: 3000 })
    await mount()
    await click('Scan')
    currentPage = page([{ ...ENTRY, title: 'Lower row' }], { start: 992, total: 3000, matched: 3000 })
    await scroll(32 * 1000)
    expect(document.querySelector('li')?.textContent).toContain('Lower row')
    const held = deferred<IpcCalls['scan:page']['res']>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await scroll(0)
    expect(document.querySelectorAll('li')).toHaveLength(0)
    expect(document.querySelector('ul')!.style.paddingTop).toBe('0px')
    expect(document.querySelector('ul')!.style.paddingBottom).toBe(`${3000 * 32}px`)
    await act(async () => held.resolve(page([{ ...ENTRY, title: 'Top row' }], { total: 3000, matched: 3000 })))
    expect(document.querySelector('li')?.textContent).toContain('Top row')
    expect(document.querySelector('li')?.textContent).not.toContain('Lower row')
  })

  it('coalesces timer ticks and query changes behind one held page request and ignores its stale reply', async () => {
    await mount()
    await click('Scan')
    const held = deferred<IpcCalls['scan:page']['res']>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await tick()
    expect(calls('scan:page')).toHaveLength(2)
    await input(searchInput(), 'old')
    await input(searchInput(), 'new')
    await tick(2500)
    expect(calls('scan:page')).toHaveLength(2)
    currentPage = page([{ ...ENTRY, title: 'Newest title' }])
    await act(async () => held.resolve(page([{ ...ENTRY, title: 'Stale title' }])))
    expect(calls('scan:page')).toHaveLength(3)
    expect(calls('scan:page').at(-1)).toEqual(['scan:page', { sessionId: 'S1', search: 'new', start: 0 }])
    expect(document.body.textContent).toContain('Newest title')
    expect(document.body.textContent).not.toContain('Stale title')
  })

  it('skips background polling while the window is hidden', async () => {
    await mount()
    await click('Scan')
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try {
      await tick(2000)
      expect(calls('scan:page')).toHaveLength(1)
      hidden.mockReturnValue(false)
      await tick()
      expect(calls('scan:page')).toHaveLength(2)
    } finally { hidden.mockRestore() }
  })

  it('keeps selection mutations and Add disabled until the updated selection page arrives', async () => {
    await mount()
    await click('Scan')
    const held = deferred<IpcCalls['scan:page']['res']>()
    ipcInvoke.mockResolvedValueOnce(undefined) // select
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await click('Clear')
    expect(button('Add 1 tape').disabled).toBe(true)
    expect(button('Select all').disabled).toBe(true)
    await act(async () => held.resolve(page([ENTRY], { selected: 0, entries: [{ ...ENTRY, selected: false }] })))
    expect(button('Select all').disabled).toBe(false)
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
  })

  it('unlocks selection after a changed query supersedes the pending selection refresh', async () => {
    await mount()
    await click('Scan')
    const older = deferred<IpcCalls['scan:page']['res']>()
    const latest = deferred<IpcCalls['scan:page']['res']>()
    ipcInvoke.mockResolvedValueOnce(undefined) // select
    ipcInvoke.mockImplementationOnce(() => older.promise)
    await click('Clear')
    await input(searchInput(), 'new query')
    expect(button('Select all').disabled).toBe(true)
    ipcInvoke.mockImplementationOnce(() => latest.promise)
    await act(async () => older.resolve(page([ENTRY], { selected: 0 })))
    expect(button('Select all').disabled).toBe(true)
    expect(calls('scan:page').at(-1)).toEqual(['scan:page', { sessionId: 'S1', search: 'new query', start: 0 }])
    await act(async () => latest.resolve(page([ENTRY], { selected: 0, entries: [{ ...ENTRY, selected: false }] })))
    expect(button('Select all').disabled).toBe(false)
    expect(button('Clear').disabled).toBe(false)
    await click('Select all')
    expect(calls('scan:select').at(-1)).toEqual(['scan:select', { sessionId: 'S1', selected: true, search: 'new query' }])
  })

  it('scopes bulk selection to the search and toggles one source through main', async () => {
    await mount()
    await click('Scan')
    await input(searchInput(), 'video')
    await click('Clear')
    expect(calls('scan:select').at(-1)).toEqual(['scan:select', { sessionId: 'S1', selected: false, search: 'video' }])
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(calls('scan:select').at(-1)).toEqual(['scan:select', { sessionId: 'S1', selected: false, sourceUrl: ENTRY.sourceUrl }])
  })

  it('resets scroll and retires completed sessions before a smaller replacement scan', async () => {
    currentPage = page([ENTRY], { total: 3000, matched: 3000, status: 'done' })
    await mount()
    await click('Scan')
    await scroll(32 * 2000)
    currentPage = page([{ ...ENTRY, title: 'Replacement row' }], { status: 'done' })
    ipcInvoke.mockImplementationOnce(async () => undefined) // release the completed session
    ipcInvoke.mockImplementationOnce(async () => ({ sessionId: 'S2' }))
    await click('Scan')
    expect(calls('scan:release')).toEqual([['scan:release', { sessionId: 'S1' }]])
    expect(calls('scan:page').at(-1)).toEqual(['scan:page', { sessionId: 'S2', search: '', start: 0 }])
    expect(document.querySelector('ul')!.scrollTop).toBe(0)
    expect(document.querySelector('ul')!.style.paddingTop).toBe('0px')
    expect(document.body.textContent).toContain('Replacement row')
  })

  it('ignores a held page after replacement and fetches the current session once it settles', async () => {
    await mount()
    await click('Scan')
    const held = deferred<IpcCalls['scan:page']['res']>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await tick()
    await click('Stop')
    ipcInvoke.mockImplementationOnce(async () => undefined) // release
    ipcInvoke.mockImplementationOnce(async () => ({ sessionId: 'S2' }))
    await click('Scan')
    currentPage = page([{ ...ENTRY, title: 'Current session row' }])
    await act(async () => held.resolve(page([{ ...ENTRY, title: 'Retired row' }], { status: 'done' })))
    expect(document.body.textContent).not.toContain('Retired row')
    expect(document.body.textContent).toContain('Current session row')
    expect(calls('scan:page').at(-1)?.[1]).toMatchObject({ sessionId: 'S2' })
  })

  it('keeps partial results selectable when the scan fails and retries transient page failures', async () => {
    currentPage = page([ENTRY], { status: 'failed' })
    await mount()
    await click('Scan')
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(button('Add 1 tape').disabled).toBe(false)
    currentPage = page()
    await click('Scan')
    ipcInvoke.mockRejectedValueOnce(new Error('private scan detail'))
    await tick()
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('private scan detail')
    await tick()
    expect(button('Stop')).toBeTruthy()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('ScanPageModal add and active title', () => {
  it('shows safe add failure text and allows retry with the server selection', async () => {
    const onClose = await mount()
    await click('Scan')
    ipcInvoke.mockRejectedValueOnce(new Error('EACCES /private/tmp/SCAN_SENTINEL'))
    await click('Add 1 tape')
    expect(onClose).not.toHaveBeenCalled()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('The selected tapes could not be added.')
    expect(alert?.textContent).not.toMatch(/EACCES|private\/tmp|SCAN_SENTINEL/)
    expect(calls('scan:add')).toEqual([['scan:add', { sessionId: 'S1' }]])
    await click('Add 1 tape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('blocks close, scans and selection while adding', async () => {
    const onClose = await mount()
    await click('Scan')
    const held = deferred<{ added: number }>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await click('Add 1 tape')
    expect(button('Stop').disabled).toBe(true)
    expect(button('Clear').disabled).toBe(true)
    await act(async () => {
      document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(calls('scan:select')).toHaveLength(0)
    await act(async () => held.resolve({ added: 1 }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retains a focused full title across pages and keeps unavailable reasons focusable', async () => {
    const long = { ...ENTRY, title: `A title ${'that keeps going '.repeat(12)}to its end` }
    const unavailable = { ...ENTRY, sourceUrl: 'https://example.test/private', title: 'Removed clip', unavailable: { reason: 'Private video' } }
    currentPage = page([long, unavailable], { matched: 3000, total: 3000 })
    await mount()
    await click('Scan')
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    await act(async () => boxes[0]!.focus())
    expect(document.querySelector('ul + p')!.textContent).toBe(long.title)
    expect(boxes[1]!.disabled).toBe(false)
    expect(boxes[1]!.getAttribute('aria-disabled')).toBe('true')
    await act(async () => boxes[1]!.focus())
    expect(document.querySelector('ul + p')!.textContent).toBe('Removed clip(Private video)')
    await act(async () => boxes[1]!.click())
    expect(calls('scan:select')).toHaveLength(0)
    currentPage = page([ENTRY], { start: 992, matched: 3000, total: 3000 })
    await scroll(32 * 1000)
    expect(document.querySelector('ul + p')!.textContent).toBe('Removed clip(Private video)')
  })

  it('does not start a scan on IME Enter', async () => {
    await mount()
    await act(async () => {
      document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    })
    expect(calls('scan:start')).toHaveLength(0)
  })
})

describe('ScanPageModal session lifetime', () => {
  it('allows a failed start to be retried', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error('private start detail'))
    await mount()
    await click('Scan')
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('private start detail')
    await click('Scan')
    expect(button('Stop')).toBeTruthy()
    expect(button('Add 1 tape')).toBeTruthy()
  })

  it.each(['dismiss', 'Stop then dismiss'] as const)('releases a late start after %s without state updates', async (action) => {
    const held = deferred<{ sessionId: string }>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await mount()
    await click('Scan')
    if (action === 'Stop then dismiss') await click('Stop')
    await act(async () => root!.unmount())
    root = null
    stateWrites.mockClear()
    await act(async () => held.resolve({ sessionId: 'late' }))
    expect(calls('scan:release')).toEqual([['scan:release', { sessionId: 'late' }]])
    expect(calls('scan:cancel')).toHaveLength(0)
    expect(stateWrites).not.toHaveBeenCalled()
  })

  it('remembers Stop before start returns, preserves results for add, and releases on dismissal', async () => {
    const held = deferred<{ sessionId: string }>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await mount()
    await click('Scan')
    await click('Stop')
    await click('Stop')
    await act(async () => held.resolve({ sessionId: 'late-stopped' }))
    expect(calls('scan:cancel')).toEqual([['scan:cancel', { sessionId: 'late-stopped' }]])
    expect(button('Scan')).toBeTruthy()
    expect(button('Add 1 tape')).toBeTruthy()
    await act(async () => root!.unmount())
    root = null
    expect(calls('scan:release')).toEqual([['scan:release', { sessionId: 'late-stopped' }]])
  })

  it('keeps Stop failures retryable and clears the failure after a successful stop', async () => {
    await mount()
    await click('Scan')
    ipcInvoke.mockRejectedValueOnce(new Error('EIO /private/tmp/STOP_SENTINEL'))
    await click('Stop')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The scan could not be stopped yet.')
    expect(document.querySelector('[role="alert"]')?.textContent).not.toMatch(/EIO|private\/tmp|STOP_SENTINEL/)
    await click('Stop')
    expect(button('Scan')).toBeTruthy()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(calls('scan:cancel')).toHaveLength(2)
  })

  it('does not let an older Stop settlement change a replacement scan', async () => {
    await mount()
    await click('Scan')
    const held = deferred<void>()
    ipcInvoke.mockImplementationOnce(() => held.promise)
    await click('Stop')
    currentPage = page([ENTRY], { status: 'done' })
    await tick()
    currentPage = page()
    ipcInvoke.mockResolvedValueOnce(undefined) // release
    ipcInvoke.mockResolvedValueOnce({ sessionId: 'S2' })
    await click('Scan')
    stateWrites.mockClear()
    await act(async () => held.resolve())
    expect(stateWrites).not.toHaveBeenCalled()
    expect(button('Stop')).toBeTruthy()
    expect(calls('scan:cancel')).toEqual([['scan:cancel', { sessionId: 'S1' }]])
  })

  it('ignores page and Stop settlement after dismissal and releases the retained session', async () => {
    await mount()
    await click('Scan')
    const heldPage = deferred<IpcCalls['scan:page']['res']>()
    ipcInvoke.mockImplementationOnce(() => heldPage.promise)
    await tick()
    const heldStop = deferred<void>()
    ipcInvoke.mockImplementationOnce(() => heldStop.promise)
    await click('Stop')
    await act(async () => root!.unmount())
    root = null
    stateWrites.mockClear()
    await act(async () => { heldPage.resolve(page()); heldStop.resolve() })
    expect(stateWrites).not.toHaveBeenCalled()
    expect(calls('scan:release')).toEqual([['scan:release', { sessionId: 'S1' }]])
  })
})
