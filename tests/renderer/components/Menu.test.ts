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

// Let the menu's open-focus requestAnimationFrame settle before a test drives focus
// itself — otherwise that queued rAF can fire mid-test and re-focus the first item,
// clobbering the keyboard-nav assertions. (Production behavior is correct; this only
// makes the test deterministic against the rAF it legitimately uses.)
async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
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

  it('portals and clamps an upward right-aligned menu outside its clipping ancestor', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const originalInnerWidth = window.innerWidth
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 })
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('[data-testid="trigger"]')) {
        return DOMRect.fromRect({ x: 17, y: 580, width: 95, height: 28 })
      }
      if (this.matches('[role="menu"]')) {
        return DOMRect.fromRect({ width: 208, height: 120 })
      }
      return originalRect.call(this)
    }

    try {
      container = document.createElement('div')
      container.style.overflow = 'hidden'
      document.body.append(container)
      root = createRoot(container)
      await act(async () => {
        root!.render(
          React.createElement(Menu, {
            label: 'Move to box',
            placement: 'top',
            align: 'right',
            trigger: (props: Record<string, unknown>) =>
              React.createElement('button', { ...props, 'data-testid': 'trigger' }, 'Move to box'),
            children: React.createElement(MenuItem, { onSelect: vi.fn(), children: 'Unboxed' }),
          }),
        )
      })
      await click(trigger())

      const popup = menu()!
      const left = Number.parseFloat(popup.style.left)
      const top = Number.parseFloat(popup.style.top)
      expect(popup.parentElement).toBe(document.body)
      expect(popup.style.position).toBe('fixed')
      expect(left).toBe(8)
      expect(left + 208).toBeLessThanOrEqual(window.innerWidth - 8)
      expect(top).toBe(456)
      expect(top).toBeGreaterThanOrEqual(8)
      expect(popup.style.visibility).toBe('visible')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
    }
  })

  it('moves focus with Down/Up (stopping at the ends) and Home/End', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    await flushRaf() // let the open-focus rAF settle before driving focus ourselves
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

  it('keeps portalled menu interactions inside and closes on an outside click', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    const outside = document.createElement('button')
    document.body.append(outside)
    await click(trigger())

    await act(async () => {
      items()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menu()).not.toBeNull()

    outside.focus()
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
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
