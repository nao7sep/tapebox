// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Menu, MenuItem } from '@renderer/components/Menu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mountMenu(onSelect: { a: () => void; b: () => void; c: () => void }): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      React.createElement(Menu, {
        label: 'Test menu',
        trigger: (props: Record<string, unknown>) =>
          React.createElement('button', { ...props, 'data-testid': 'trigger' }, 'Open'),
        children: [
          React.createElement(MenuItem, { onSelect: onSelect.a, key: 'a', children: 'Apple' }),
          React.createElement(MenuItem, { onSelect: onSelect.b, key: 'b', children: 'Banana' }),
          React.createElement(MenuItem, { onSelect: onSelect.c, key: 'c', children: 'Cherry' }),
        ],
      }),
    )
  })
}

const trigger = () => document.querySelector('[data-testid="trigger"]') as HTMLButtonElement
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null
const items = () => Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function key(el: HTMLElement, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('Menu', () => {
  it('marks the trigger as a menu opener', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(menu()).toBeNull()
  })

  it('opens on trigger click and exposes the items as menuitems', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    expect(menu()).not.toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(items().map((i) => i.textContent)).toEqual(['Apple', 'Banana', 'Cherry'])
    // Items are not their own tab stops; the menu is navigated by the arrows.
    expect(items().every((i) => i.getAttribute('tabindex') === '-1')).toBe(true)
  })

  it('moves focus with Down/Up (stopping at the ends) and Home/End', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    items()[0].focus()
    await key(items()[0], 'ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    await key(items()[1], 'End')
    expect(document.activeElement).toBe(items()[2])
    await key(items()[2], 'ArrowDown') // stops at the last item
    expect(document.activeElement).toBe(items()[2])
    await key(items()[2], 'Home')
    expect(document.activeElement).toBe(items()[0])
    await key(items()[0], 'ArrowUp') // stops at the first item
    expect(document.activeElement).toBe(items()[0])
  })

  it('Escape closes the menu and returns focus to the trigger', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    items()[0].focus()
    await key(items()[0], 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('activating an item runs its action and closes the menu', async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await click(trigger())
    await click(items()[1])
    expect(onSelect.b).toHaveBeenCalledOnce()
    expect(onSelect.a).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })
})
