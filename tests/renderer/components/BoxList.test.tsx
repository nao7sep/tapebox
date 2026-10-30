// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxList } from '@renderer/components/BoxList'
import { WindowCloseGuard } from '@renderer/components/WindowCloseGuard'
import { windowCloseState } from '@renderer/lib/windowClose'
import { useBoxesStore } from '@renderer/store/boxes'
import type { Tape } from '@shared/domain'
import { useTapesStore } from '@renderer/store/tapes'
import { useArchiveStore } from '@renderer/store/archive'
import { useBoxActionResultsStore } from '@renderer/store/boxActionResults'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), closeRequest: ((_request: { requestId: number; ask: boolean }) => {}) as (request: { requestId: number; ask: boolean }) => void }))
vi.mock('@renderer/ipc/client', () => ({
  ipcInvoke: bridge.invoke,
  ipcOn: (_channel: string, listener: (request: { requestId: number; ask: boolean }) => void) => { bridge.closeRequest = listener; return () => {} },
}))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), warn: vi.fn() } }))
vi.mock('@dnd-kit/react', () => ({ useDroppable: () => ({ ref: () => {}, isDropTarget: false }) }))
vi.mock('@dnd-kit/react/sortable', () => ({ useSortable: () => ({ ref: () => {} }) }))
vi.mock('@renderer/lib/dnd', () => ({ BOX_DRAG_TYPE: 'box', BOX_SORT_GROUP: 'boxes', BOX_TARGET_TYPE: 'box-target', TAPE_DRAG_TYPE: 'tape' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const input = () => document.querySelector('input') as HTMLInputElement

beforeEach(async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  bridge.invoke.mockReset().mockImplementation(async (channel: string) => channel === 'app:quitDraftsReady' ? true : undefined)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useTapesStore.setState({ tapes: [] })
  useArchiveStore.setState({ selectedBoxId: null })
  useBoxesStore.setState({ editingId: null, draftName: '', pendingRenames: 0, boxes: [{ id: 'box1', name: 'Original', order: 0 }] })
  useBoxActionResultsStore.setState({ results: {} })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Fragment, null,
    createElement(BoxList, { onReorder: () => {}, orderError: null, onDismissOrderError: () => {} }),
    createElement(WindowCloseGuard),
  )))
  await act(async () => (document.querySelector('[aria-label="Rename box"]') as HTMLButtonElement).click())
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  document.body.innerHTML = ''
})

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('box draft at quit', () => {
  it('does not restore an old rename draft or result after another collection opens', async () => {
    let fail!: (reason: Error) => void
    bridge.invoke.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await type('Old collection draft')
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => useBoxesStore.setState({ collection: {}, boxes: [{ id: 'box1', name: 'New collection', order: 0 }], editingId: null, draftName: '', pendingRenames: 0 }))
    await act(async () => fail(new Error('old rename failed')))
    expect(useBoxesStore.getState()).toMatchObject({ editingId: null, draftName: '', pendingRenames: 0 })
    expect(useBoxActionResultsStore.getState().results).toEqual({})
    expect(document.body.textContent).not.toContain('The box could not be renamed.')
  })

  it('does not save on window departure or while asking to discard, and keeps invalid text on blur', async () => {
    await type('Unfinished')
    vi.mocked(document.hasFocus).mockReturnValue(false)
    await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(bridge.invoke).not.toHaveBeenCalled()
    vi.mocked(document.hasFocus).mockReturnValue(true)
    await act(async () => bridge.closeRequest({ requestId: 1, ask: true }))
    expect(bridge.invoke.mock.calls).toEqual([['app:quitDraftsReady', { requestId: 1 }]])
    const keep = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Keep editing')!
    await act(async () => keep.click())
    expect(input().value).toBe('Unfinished')
    await type('')
    await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(input().value).toBe('')
    expect(windowCloseState().dirty).toBe(true)
  })

  it('retains a failed rename\'s draft', async () => {
    let fail!: (reason: Error) => void
    bridge.invoke.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await type('Keep on failure')
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => fail(new Error('failed save')))
    expect(windowCloseState()).toEqual({ dirty: true })
    expect(input().value).toBe('Keep on failure')
    expect(document.body.textContent).toContain('The box could not be renamed.')
  })
})

it('marks the whole selected box row for keyboard emphasis while hover leaves navigation alone', async () => {
  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!
  await act(async () => {
    list.focus()
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'))
  const selected = options[1]!
  expect(selected.getAttribute('aria-selected')).toBe('true')
  expect(selected.parentElement!.classList.contains('listbox-item')).toBe(true)
  expect(selected.parentElement!.matches(':has(> [role="option"][aria-selected="true"])')).toBe(true)
  await act(async () => options[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(useArchiveStore.getState().selectedBoxId).toBe('box1')
  expect(document.activeElement).toBe(list)
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
  expect(useArchiveStore.getState().selectedBoxId).toBeNull()
  expect(bridge.invoke).not.toHaveBeenCalled()
})


async function showArchive(visible: boolean) {
  await act(async () => root.render(createElement(Fragment, null,
    visible ? createElement(BoxList, { onReorder: () => {}, orderError: null, onDismissOrderError: () => {} }) : null,
    createElement(WindowCloseGuard),
  )))
}

describe('box draft across Archive/Inbox navigation', () => {
  it('retains exact invalid text while the Archive view is absent', async () => {
    await type('   ')
    await showArchive(false)
    expect(windowCloseState().dirty).toBe(true)
    await showArchive(true)
    expect(input().value).toBe('   ')
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it('keeps a pending rename owned and restores the exact failed draft after navigation', async () => {
    let fail!: (reason: Error) => void
    bridge.invoke.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await type('  Keep on failure  ')
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await showArchive(false)
    await act(async () => fail(new Error('failed save')))
    expect(windowCloseState()).toEqual({ dirty: true })
    await showArchive(true)
    expect(input().value).toBe('  Keep on failure  ')
    expect(document.body.textContent).toContain('The box could not be renamed.')
  })
})

// A box name is identifying text: one line in the list; the rename field holds it
// whole (interface-styling-conventions, Labels).
describe('a long box name', () => {
  const long = Array.from({ length: 12 }, (_, i) => `segment${i}`).join(' ')

  it('takes one line in the list', async () => {
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => useBoxesStore.setState({ boxes: [{ id: 'box1', name: long, order: 0 }] }))
    const option = [...document.querySelectorAll('[role="option"]')].find((element) => element.textContent === long)!
    expect(option.className.split(/\s+/)).toContain('truncate')
  })
})


describe('selected box actions', () => {
  async function selectBox() {
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    await act(async () => {
      list.focus()
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    return list
  }
  const actions = () => document.querySelector<HTMLButtonElement>('[aria-label="Box actions"]')!
  const key = async (element: HTMLElement, value: string, shiftKey = false) => {
    await act(async () => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })))
  }

  it('keeps a visible command trigger outside the single-tab-stop list and preserves hover actions', async () => {
    const list = await selectBox()
    expect(actions().disabled).toBe(false)
    expect(list.contains(actions())).toBe(false)
    expect(actions().classList.contains('hidden')).toBe(false)
    expect(list.tabIndex).toBe(0)
    expect([...list.querySelectorAll('button')].every((button) => button.tabIndex === -1)).toBe(true)
    expect(list.querySelectorAll('.group-hover\\:inline-flex')).toHaveLength(2)
    await key(list, 'ArrowUp')
    expect(actions().disabled).toBe(true)
    await key(list, 'ContextMenu')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it.each(['ContextMenu', 'F10'])('opens selected commands with %s and restores focus on Escape', async (value) => {
    const list = await selectBox()
    await key(list, value, value === 'F10')
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.parentElement).toBe(document.body)
    expect(document.activeElement?.textContent).toBe('Rename box')
    await key(menu, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Delete box')
    await key(menu, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(actions())
  })

  it('uses the existing rename and delete confirmation paths for the selected box', async () => {
    await selectBox()
    await act(async () => actions().click())
    await key(document.querySelector<HTMLElement>('[role="menu"]')!, 'Enter')
    expect(input().value).toBe('Original')
    expect(document.activeElement).toBe(input())
    await key(input(), 'Escape')
    await act(async () => actions().click())
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    await key(menu, 'ArrowDown')
    await key(menu, 'Enter')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(bridge.invoke).not.toHaveBeenCalled()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Delete box')!
    await act(async () => confirm.click())
    expect(bridge.invoke).toHaveBeenCalledWith('boxes:delete', { boxId: 'box1' })
  })
})


describe('new box reply ownership', () => {
  it.each(['draft', 'selection', 'collection'])('keeps a newer %s when creation settles', async (change) => {
    let finish!: (box: { id: string; name: string; order: number }) => void
    bridge.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const create = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'New box')!
    await act(async () => create.click())
    await act(async () => {
      if (change === 'selection') useArchiveStore.getState().selectBox('other')
      else if (change === 'collection') useBoxesStore.setState({ collection: {}, editingId: null, draftName: '' })
    })
    if (change === 'draft') await type('Newer draft')
    const { editingId, draftName } = useBoxesStore.getState()
    const { selectedBoxId } = useArchiveStore.getState()
    await act(async () => finish({ id: 'new', name: 'New box', order: 1 }))
    expect(useBoxesStore.getState()).toMatchObject({ editingId, draftName })
    expect(useArchiveStore.getState().selectedBoxId).toBe(selectedBoxId)
  })

  it('lets only the newest creation reply open editing', async () => {
    const finish: Array<(box: { id: string; name: string; order: number }) => void> = []
    bridge.invoke.mockImplementation(() => new Promise(resolve => finish.push(resolve)))
    const create = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'New box')!
    await act(async () => { create.click(); create.click() })
    await act(async () => finish[0]!({ id: 'first', name: 'First', order: 1 }))
    expect(useBoxesStore.getState().editingId).toBe('box1')
    await act(async () => finish[1]!({ id: 'second', name: 'Second', order: 2 }))
    expect(useBoxesStore.getState()).toMatchObject({ editingId: 'second', draftName: 'Second' })
    expect(useArchiveStore.getState().selectedBoxId).toBe('second')
  })
})

it('derives archived counts after moves and unarchiving, including Unboxed', async () => {
  const tape: Tape = {
    id: 'TapeID0001', sourceUrl: 'https://example.test', state: 'downloaded', addedAtUtc: '2026-01-01T00:00:00Z',
    sourceId: null, extractor: null, title: null, uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: null, name: null, renamedAtUtc: null, addedIndex: 0, shelved: true,
    boxId: 'box1', order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
  const counts = () => [...document.querySelectorAll('.tabular-nums')].map((node) => node.textContent)
  await act(async () => {
    useBoxesStore.setState({ editingId: null })
    useTapesStore.setState({ tapes: [tape, { ...tape, id: 'TapeID0002', boxId: null }, { ...tape, id: 'TapeID0003', shelved: false, boxId: null }] })
  })
  expect(counts()).toEqual(['1', '1'])
  await act(async () => useTapesStore.getState().upsert({ ...tape, boxId: null }))
  expect(counts()).toEqual(['2', '0'])
  await act(async () => useTapesStore.getState().upsert({ ...tape, boxId: null, shelved: false }))
  expect(counts()).toEqual(['1', '0'])
})
