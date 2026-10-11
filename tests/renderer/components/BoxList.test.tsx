// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxList } from '@renderer/components/BoxList'
import { WindowCloseGuard } from '@renderer/components/WindowCloseGuard'
import { windowCloseState } from '@renderer/lib/windowClose'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBoxActionResultsStore } from '@renderer/store/boxActionResults'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), closeRequest: (() => {}) as () => void }))
vi.mock('@renderer/ipc/client', () => ({
  ipcInvoke: bridge.invoke,
  ipcOn: (_channel: string, listener: () => void) => { bridge.closeRequest = listener; return () => {} },
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
  bridge.invoke.mockReset().mockResolvedValue(undefined)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useBoxesStore.setState({ boxes: [{ id: 'box1', name: 'Original', order: 0 }] })
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

describe('box draft on workspace close', () => {
  it('does not save on window departure or while asking to discard, and keeps invalid text on blur', async () => {
    await type('Unfinished')
    vi.mocked(document.hasFocus).mockReturnValue(false)
    await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(bridge.invoke).not.toHaveBeenCalled()
    vi.mocked(document.hasFocus).mockReturnValue(true)
    await act(async () => bridge.closeRequest())
    expect(bridge.invoke).not.toHaveBeenCalled()
    const keep = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Keep editing')!
    await act(async () => keep.click())
    expect(input().value).toBe('Unfinished')
    await type('')
    await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(input().value).toBe('')
    expect(windowCloseState().dirty).toBe(true)
  })

  it('holds the owner through a submitted rename and retains its failed draft', async () => {
    let fail!: (reason: Error) => void
    bridge.invoke.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await type('Keep on failure')
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(windowCloseState().busy).toBe(true)
    await act(async () => bridge.closeRequest())
    expect(bridge.invoke.mock.calls.map((call) => call[0])).toEqual(['boxes:rename'])
    await act(async () => fail(new Error('failed save')))
    expect(windowCloseState()).toEqual({ dirty: true, busy: false })
    expect(input().value).toBe('Keep on failure')
    expect(document.body.textContent).toContain('The box could not be renamed.')
  })
})
