// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { useTapesStore } from '@renderer/store/tapes'
import { useArchiveStore } from '@renderer/store/archive'
import { useFilterStore } from '@renderer/store/filter'
import { useSelectionStore } from '@renderer/store/selection'
import { useBoxesStore } from '@renderer/store/boxes'
import * as order from '@renderer/lib/tapeOrder'

const drag = vi.hoisted(() => ({ provider: null as Record<string, any> | null, id: null as string | null, notify: () => {}, indices: new Map<string, number>() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: vi.fn(async () => undefined), ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))
vi.mock('@dnd-kit/dom', () => ({
  Accessibility: class {},
  PointerActivationConstraints: { Distance: class {} },
  PointerSensor: { configure: () => ({}) },
}))
vi.mock('@dnd-kit/react', async () => {
  const React = await import('react')
  return { DragDropProvider: ({ children, ...props }: { children: ReactNode }) => { drag.provider = props; return React.createElement(React.Fragment, null, children) } }
})
vi.mock('@dnd-kit/react/sortable', async () => {
  const React = await import('react')
  return {
    isSortable: () => false, isSortableOperation: () => false,
    useSortable: ({ id, index }: { id: string; index: number }) => {
      const active = React.useSyncExternalStore((notify) => { drag.notify = notify; return () => {} }, () => drag.id)
      drag.indices.set(id, index)
      return { ref: () => {}, isDragSource: active === id }
    },
  }
})

import { TapeList } from '@renderer/components/TapeList'
import { ArchiveTapeList } from '@renderer/components/ArchiveTapeList'
import { SearchResults } from '@renderer/components/SearchResults'
import { rowAtOffset } from '@renderer/lib/useVirtualRows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const resizeCallbacks: ResizeObserverCallback[] = []
const count = 2000
function tapes(archived: boolean): Tape[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `Tape${String(i).padStart(6, '0')}`, title: `Video ${i}`, sourceUrl: 'https://example.test/video',
    state: 'downloading', order: i, boxId: archived && i >= 1000 ? 'Box0000001' : null,
    archivedAtUtc: archived ? '2026-10-23T00:00:00Z' : null, addedAtUtc: '2026-10-23T00:00:00Z',
  } as Tape))
}
function listbox() { return host.querySelector<HTMLElement>('[role="listbox"]')! }
async function scroll(top: number) {
  await act(async () => { listbox().scrollTop = top; listbox().dispatchEvent(new Event('scroll')) })
}

beforeEach(() => {
  drag.id = null; drag.indices.clear(); drag.notify = () => {}
  resizeCallbacks.length = 0
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) }
    observe() {} unobserve() {} disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  useTapesStore.setState({ tapes: [], progress: {}, stalled: {} })
  useSelectionStore.setState({ selectedId: null })
  useArchiveStore.setState({ selectedBoxId: null, query: '' })
  useBoxesStore.setState({ boxes: [{ id: 'Box0000001', name: 'A box', order: 0 }] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('virtual tape listboxes', () => {
  it.each(['inbox', 'box', 'search'] as const)('bounds %s rows and mounts and scrolls End selection', async (kind) => {
    const catalog = tapes(kind !== 'inbox')
    // A box owns one continuous sequence; search owns two groups.
    if (kind === 'box') catalog.forEach((tape) => { tape.boxId = null })
    useTapesStore.setState({ tapes: catalog })
    useFilterStore.setState({ filter: kind === 'inbox' ? 'inbox' : 'archived' })
    if (kind === 'search') useArchiveStore.setState({ query: 'Video' })
    await act(async () => root.render(kind === 'inbox' ? createElement(TapeList) : kind === 'search' ? createElement(SearchResults) : createElement(ArchiveTapeList, { onReorder: () => {}, orderError: null, onDismissOrderError: () => {} })))
    expect(host.querySelectorAll('[role="option"]').length).toBeLessThan(30)
    expect(listbox().tabIndex).toBe(0)
    await act(async () => listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(useSelectionStore.getState().selectedId).toBe(catalog.at(-1)!.id)
    expect(document.getElementById(listbox().getAttribute('aria-activedescendant')!)).not.toBeNull()
    expect(listbox().scrollTop).toBeGreaterThan(100000)
    expect(host.querySelectorAll('[role="option"]').length).toBeLessThan(30)
    if (kind === 'search') {
      expect(host.querySelectorAll('section[role="group"]')).toHaveLength(2)
      expect(host.querySelectorAll('.sticky')).toHaveLength(2)
    }
  })

  it('retains the active dragged stable ID while scrolling to new global targets', async () => {
    useFilterStore.setState({ filter: 'inbox' })
    useTapesStore.setState({ tapes: tapes(false) })
    await act(async () => root.render(createElement(TapeList)))
    // Notify every sortable through React's store subscription.
    await act(async () => { drag.id = 'Tape000001'; root.render(createElement(TapeList)) })
    await scroll(74000)
    expect(document.querySelector('[data-virtual-id="Tape000001"]')).not.toBeNull()
    expect(drag.indices.get('Tape001000')).toBe(1000)
    expect(document.querySelector('[data-virtual-id="Tape001000"]')).not.toBeNull()
    expect(host.querySelectorAll('[role="option"]').length).toBeLessThan(30)
  })

  it('previews full-list moves without changing the catalog and clears on cancel', async () => {
    useFilterStore.setState({ filter: 'inbox' })
    const catalog = tapes(false)
    useTapesStore.setState({ tapes: catalog })
    await act(async () => root.render(createElement(TapeList)))
    const preventDefault = vi.fn()
    await act(async () => drag.provider!.onDragOver({
      preventDefault,
      operation: { source: { id: 'Tape000001', type: 'tape' }, target: { id: 'Tape001000', type: 'tape' } },
    }))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(useTapesStore.getState().tapes).toBe(catalog)
    expect(host.querySelector<HTMLElement>('[data-virtual-id="Tape000002"]')?.style.top).toBe('86px')
    await scroll(74000)
    expect(host.querySelector<HTMLElement>('[data-virtual-id="Tape000001"]')?.style.top).toBe('74012px')
    expect(drag.indices.get('Tape000001')).toBe(1)
    await act(async () => drag.provider!.onDragEnd({ canceled: true, operation: {} }))
    expect(useTapesStore.getState().tapes).toBe(catalog)
    expect(host.querySelector<HTMLElement>('[data-virtual-id="Tape001000"]')?.style.top).toBe('74012px')
  })

  it('batches measured row sizes into one frame and updates prefix placement', async () => {
    useFilterStore.setState({ filter: 'inbox' })
    useTapesStore.setState({ tapes: tapes(false) })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    await act(async () => root.render(createElement(TapeList)))
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-virtual-id="${id}"]`)!
    const notify = resizeCallbacks[0]!
    const entry = (id: string, height: number) => ({ target: row(id), borderBoxSize: [{ blockSize: height }] }) as unknown as ResizeObserverEntry
    await act(async () => {
      notify([entry('Tape000000', 100)], {} as ResizeObserver)
      notify([entry('Tape000001', 90)], {} as ResizeObserver)
    })
    expect(frames).toHaveLength(1)
    expect(row('Tape000002').style.top).toBe('160px')
    await act(async () => frames[0]!(0))
    expect(row('Tape000002').style.top).toBe('214px')
  })

  it('updates only a row when unrelated progress arrives, without rerunning list derivation', async () => {
    useFilterStore.setState({ filter: 'inbox' })
    useTapesStore.setState({ tapes: tapes(false) })
    const derive = vi.spyOn(order, 'useVisibleTapes')
    await act(async () => root.render(createElement(TapeList)))
    derive.mockClear()
    await act(async () => useTapesStore.setState({ progress: { Tape000001: { phase: 'downloading', percent: 42 } } }))
    expect(derive).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLElement>('[data-virtual-id="Tape000001"] .bg-progress')?.style.width).toBe('42%')
  })
})

it('binary searches measured prefix boundaries', () => {
  expect(rowAtOffset([0, 20, 80, 100], 19)).toBe(0)
  expect(rowAtOffset([0, 20, 80, 100], 20)).toBe(1)
  expect(rowAtOffset([0, 20, 80, 100], 99)).toBe(2)
})
