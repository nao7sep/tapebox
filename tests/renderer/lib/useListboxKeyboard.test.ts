// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useListboxKeyboard, useAutoFocusList } from '@renderer/lib/useListboxKeyboard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scrollIntoView = vi.fn()

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; the hook calls it when the active id moves.
  Element.prototype.scrollIntoView = scrollIntoView
})

let root: Root | null = null

function mount(el: React.ReactElement): void {
  // Tear down any prior tree first, so a test that mounts more than once never
  // leaves two trees (and two #lb ids) in the document at the same time.
  if (root !== null) {
    act(() => root!.unmount())
    root = null
  }
  document.body.innerHTML = ''
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(el))
}

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount())
    root = null
  }
  document.body.innerHTML = ''
  scrollIntoView.mockClear()
})

// ── Navigation ───────────────────────────────────────────────────────────────

const ITEMS = ['a', 'b', 'c', 'd', 'e']

function Listbox(props: {
  itemIds: string[]
  activeId: string | null
  onActivate: (id: string) => void
  onCommandKey?: (e: React.KeyboardEvent, activeId: string | null) => boolean
  onReorder?: (activeId: string, offset: -1 | 1) => void
}): React.ReactElement {
  const kb = useListboxKeyboard<HTMLUListElement>({
    itemIds: props.itemIds,
    activeId: props.activeId,
    onActivate: props.onActivate,
    idPrefix: 'test',
    page: 3,
    onCommandKey: props.onCommandKey,
    onReorder: props.onReorder,
  })
  return React.createElement(
    'ul',
    { ref: kb.ref, ...kb.listboxProps, id: 'lb' },
    props.itemIds.map((id) => React.createElement('li', { key: id, id: kb.optionId(id), role: 'option' }, id)),
  )
}

const lb = () => document.getElementById('lb')!
function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    lb().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

function renderListbox(activeId: string | null, opts?: Partial<Parameters<typeof Listbox>[0]>) {
  const onActivate = vi.fn()
  mount(React.createElement(Listbox, { itemIds: ITEMS, activeId, onActivate, ...opts }))
  return onActivate
}

describe('useListboxKeyboard navigation', () => {
  it('moves down and up by one', () => {
    let onActivate = renderListbox('b')
    press('ArrowDown')
    expect(onActivate).toHaveBeenCalledWith('c')

    onActivate = renderListbox('b')
    press('ArrowUp')
    expect(onActivate).toHaveBeenCalledWith('a')
  })

  it('clamps at the ends — no wrap', () => {
    let onActivate = renderListbox('e')
    press('ArrowDown')
    expect(onActivate).toHaveBeenCalledWith('e')

    onActivate = renderListbox('a')
    press('ArrowUp')
    expect(onActivate).toHaveBeenCalledWith('a')
  })

  it('Home / End jump to the ends', () => {
    let onActivate = renderListbox('c')
    press('Home')
    expect(onActivate).toHaveBeenCalledWith('a')

    onActivate = renderListbox('c')
    press('End')
    expect(onActivate).toHaveBeenCalledWith('e')
  })

  it('enters the list from no selection (Down → first, Up → last)', () => {
    let onActivate = renderListbox(null)
    press('ArrowDown')
    expect(onActivate).toHaveBeenCalledWith('a')

    onActivate = renderListbox(null)
    press('ArrowUp')
    expect(onActivate).toHaveBeenCalledWith('e')
  })

  it('PageDown / PageUp move by the page step, clamped', () => {
    let onActivate = renderListbox('a')
    press('PageDown') // 0 + 3 = 3 → 'd'
    expect(onActivate).toHaveBeenCalledWith('d')

    onActivate = renderListbox('e')
    press('PageUp') // 4 - 3 = 1 → 'b'
    expect(onActivate).toHaveBeenCalledWith('b')
  })

  it('exposes the active option via aria-activedescendant', () => {
    renderListbox('c')
    expect(lb().getAttribute('aria-activedescendant')).toBe('test-opt-c')
  })

  it('lets a command key consume the event before navigation', () => {
    const onCommandKey = vi.fn((e: React.KeyboardEvent) => e.key === 'Delete')
    const onActivate = renderListbox('b', { onCommandKey })
    press('Delete')
    expect(onCommandKey).toHaveBeenCalled()
    expect(onActivate).not.toHaveBeenCalled()

    press('ArrowDown') // a non-command key still navigates
    expect(onActivate).toHaveBeenCalledWith('c')
  })

  it('routes Cmd/Ctrl+Shift+Up/Down to reorder without moving selection', () => {
    const onReorder = vi.fn()
    let onActivate = renderListbox('c', { onReorder })
    press('ArrowUp', { metaKey: true, shiftKey: true })
    expect(onReorder).toHaveBeenCalledWith('c', -1)
    expect(onActivate).not.toHaveBeenCalled()

    onReorder.mockClear()
    onActivate = renderListbox('c', { onReorder })
    press('ArrowDown', { ctrlKey: true, shiftKey: true })
    expect(onReorder).toHaveBeenCalledWith('c', 1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('scrolls the preserved active item into view after its order changes', () => {
    const onActivate = vi.fn()
    mount(React.createElement(Listbox, { itemIds: ITEMS, activeId: 'c', onActivate }))
    scrollIntoView.mockClear()

    act(() => {
      root!.render(React.createElement(Listbox, {
        itemIds: ['a', 'b', 'd', 'c', 'e'],
        activeId: 'c',
        onActivate,
      }))
    })

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('does not treat plain or Alt-modified arrows as reorder commands', () => {
    const onReorder = vi.fn()
    const onActivate = renderListbox('c', { onReorder })
    press('ArrowUp')
    expect(onActivate).toHaveBeenCalledWith('b')
    expect(onReorder).not.toHaveBeenCalled()

    onActivate.mockClear()
    press('ArrowDown', { metaKey: true, shiftKey: true, altKey: true })
    expect(onActivate).toHaveBeenCalledWith('d')
    expect(onReorder).not.toHaveBeenCalled()
  })
})

// ── useAutoFocusList ──────────────────────────────────────────────────────────

function AutoFocused(): React.ReactElement {
  const ref = React.useRef<HTMLUListElement>(null)
  useAutoFocusList(ref)
  return React.createElement('ul', { ref, id: 'af', tabIndex: 0 })
}

const tree = (withList: boolean): React.ReactElement =>
  React.createElement(
    'div',
    null,
    React.createElement('input', { id: 'inp' }),
    withList ? React.createElement(AutoFocused) : null,
  )

describe('useAutoFocusList', () => {
  it('focuses the list on mount when nothing is focused', () => {
    mount(React.createElement(AutoFocused))
    expect(document.activeElement).toBe(document.getElementById('af'))
  })

  it('never steals focus from a text field', () => {
    // Mount the input WITHOUT the list, focus it, then re-render the SAME tree with the
    // list appended — the input element persists (keeps focus), so the newly-mounted
    // list must not yank it away.
    mount(tree(false))
    const input = document.getElementById('inp') as HTMLInputElement
    act(() => input.focus())
    expect(document.activeElement).toBe(input)

    act(() => root!.render(tree(true)))
    expect(document.activeElement).toBe(input)
  })
})
