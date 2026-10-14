// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Menu, MenuItem, MENU_MAX_WIDTH } from '@renderer/components/Menu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

async function mountMenu(
  onSelect: { a: () => void; b: () => void; c: () => void },
  choice?: { selected: number; disabled?: number },
): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      React.createElement(Menu, {
        label: 'Test menu',
        trigger: (props: Record<string, unknown>) =>
          React.createElement('button', { ...props, 'data-testid': 'trigger' }, 'Open'),
        children: ['Apple', 'Banana', 'Cherry'].map((label, index) => React.createElement(MenuItem, {
          onSelect: [onSelect.a, onSelect.b, onSelect.c][index],
          key: label,
          children: label,
          selected: choice ? choice.selected === index : undefined,
          disabled: choice?.disabled === index,
        })),
      }),
    )
  })
}

const trigger = () => document.querySelector('[data-testid="trigger"]') as HTMLButtonElement
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null
const items = () => Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')) as HTMLElement[]

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  })
}

// A later frame must not reset navigation that already began on opening.
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
  it('focuses only after the popup is visible and does not reset navigation when repositioned', async () => {
    const focus = HTMLElement.prototype.focus
    const attempts: string[] = []
    const observeFocus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      const popup = this.closest<HTMLElement>('[role="menu"]')
      if (popup) attempts.push(popup.style.visibility)
      focus.call(this, options)
    })
    try {
      await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
      await click(trigger())
      expect(attempts).toEqual(['visible'])
      await key(items()[0], 'ArrowDown')
      await act(async () => window.dispatchEvent(new Event('resize')))
      expect(document.activeElement).toBe(items()[1])
      expect(attempts).toEqual(['visible', 'visible'])
    } finally {
      observeFocus.mockRestore()
    }
  })

  it('initializes pointer entry before the first arrow without showing plain-focus emphasis', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    expect(document.activeElement).toBe(items()[0])
    expect(items()[0].className).not.toMatch(/(?:^|\s)focus:(?:bg-|text-)/)
    expect(items()[0].className).toContain('focus-visible:outline-offset-[-2px]')
    await key(items()[0], 'ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    await flushRaf()
    expect(document.activeElement).toBe(items()[1])
  })

  it.each([
    ['ArrowDown', 0, 'ArrowDown', 1],
    ['ArrowUp', 2, 'ArrowUp', 1],
    ['Enter', 0, 'ArrowDown', 1],
    [' ', 0, 'ArrowDown', 1],
  ] as const)('opens from %s at the appropriate command and the next arrow moves', async (opening, initial, arrow, next) => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    trigger().focus()
    await key(trigger(), opening)
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(items()[initial])
    await key(document.activeElement as HTMLElement, arrow)
    expect(document.activeElement).toBe(items()[next])
  })

  it.each(['Enter', ' '])('hover over an earlier item cannot change subsequent navigation or %s activation', async (activation) => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await key(trigger(), 'ArrowDown')
    await key(items()[0], 'ArrowDown')
    await key(items()[1], 'ArrowDown')
    await act(async () => {
      items()[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      items()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    expect(document.activeElement).toBe(items()[2])
    await key(items()[2], 'ArrowUp')
    expect(document.activeElement).toBe(items()[1])
    await key(items()[1], activation)
    expect(onSelect.b).toHaveBeenCalledOnce()
    expect(onSelect.a).not.toHaveBeenCalled()
    expect(onSelect.c).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('Enter straight after hovering an earlier item activates the keyboard target', async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await key(trigger(), 'ArrowDown')
    await key(items()[0], 'ArrowDown')
    await key(items()[1], 'ArrowDown')
    await act(async () => {
      items()[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      items()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    await key(document.activeElement as HTMLElement, 'Enter')
    expect(onSelect.c).toHaveBeenCalledOnce()
    expect(onSelect.a).not.toHaveBeenCalled()
  })

  it('keeps the keyboard target on the same item when the items reorder live', async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await key(trigger(), 'ArrowDown')
    await key(items()[0], 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Banana')
    // A live update (another window renaming or reordering boxes) re-renders the
    // open menu with the same keyed items in a new order.
    const handlers: Record<string, () => void> = { Apple: onSelect.a, Banana: onSelect.b, Cherry: onSelect.c }
    await act(async () => {
      root!.render(
        React.createElement(Menu, {
          label: 'Test menu',
          trigger: (props: Record<string, unknown>) =>
            React.createElement('button', { ...props, 'data-testid': 'trigger' }, 'Open'),
          children: ['Cherry', 'Apple', 'Banana'].map((label) => React.createElement(MenuItem, {
            onSelect: handlers[label]!, key: label, children: label,
          })),
        }),
      )
    })
    expect(items().map((item) => item.textContent)).toEqual(['Cherry', 'Apple', 'Banana'])
    expect(document.activeElement?.textContent).toBe('Banana')
    await key(document.activeElement as HTMLElement, 'Enter')
    expect(onSelect.b).toHaveBeenCalledOnce()
    expect(onSelect.a).not.toHaveBeenCalled()
    expect(onSelect.c).not.toHaveBeenCalled()
  })

  it('click activates the clicked command even while another command is the keyboard target', async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await key(trigger(), 'ArrowUp')
    await click(items()[0])
    expect(onSelect.a).toHaveBeenCalledOnce()
    expect(onSelect.c).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it.each(['pointer', 'ArrowDown', 'ArrowUp'])('starts %s entry at the selected eligible choice and retains its check state during navigation', async (opening) => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() }, { selected: 1 })
    if (opening === 'pointer') await click(trigger())
    else await key(trigger(), opening)
    expect(document.activeElement).toBe(items()[1])
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    await key(items()[1], 'ArrowDown')
    expect(document.activeElement).toBe(items()[2])
    expect(items()[1].getAttribute('aria-checked')).toBe('true')
    expect(items()[1].className).toContain('hover:bg-raised')
    expect(items()[1].className).toContain('focus-visible:outline-offset-[-2px]')
  })

  it('falls back from an ineligible selected choice and skips it while navigating', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() }, { selected: 1, disabled: 1 })
    await key(trigger(), 'ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    await key(items()[0], 'ArrowDown')
    expect(document.activeElement).toBe(items()[2])
  })

  it('does not navigate or activate a command while choosing an IME candidate', async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await key(trigger(), 'ArrowDown')
    await key(items()[0], 'ArrowDown', { isComposing: true })
    await key(items()[0], 'Enter', { isComposing: true })
    expect(document.activeElement).toBe(items()[0])
    expect(menu()).not.toBeNull()
    expect(onSelect.a).not.toHaveBeenCalled()
    await key(items()[0], 'b')
    expect(document.activeElement).toBe(items()[1])
    await key(items()[1], 'Enter')
    expect(onSelect.b).toHaveBeenCalledOnce()
  })

  it('suppresses native button activation during composition and clears that owner when the popup closes', async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
    await mountMenu(onSelect)
    await key(trigger(), 'ArrowDown')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      menu()!.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      items()[0].dispatchEvent(enter)
    })
    expect(enter.defaultPrevented).toBe(true)
    expect(onSelect.a).not.toHaveBeenCalled()
    await click(trigger())
    expect(menu()).toBeNull()
    await key(trigger(), 'ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    await key(items()[0], 'Enter')
    expect(onSelect.a).toHaveBeenCalledOnce()
  })

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
    expect(document.activeElement).toBe(items()[0])
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

  // A menu sizes to its longest item rather than a fixed width, so a long label
  // (e.g. "キーボードショートカット") never wraps onto a second line.
  it('sizes to content instead of a fixed width, and never wraps an item label', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    const popupClass = menu()!.className
    expect(popupClass).not.toMatch(/(?:^|\s)w-\d+(?:\s|$)/)
    expect(popupClass).toMatch(/w-max/)
    for (const item of items()) {
      expect(item.className).toMatch(/whitespace-nowrap/)
    }
  })

  // A long box name must not stretch the menu toward the window's edge: the menu
  // stops at a narrow cap (or the viewport) and the label ends in an ellipsis.
  it('caps its width and shortens a label that would pass the cap', async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() })
    await click(trigger())
    expect(menu()!.style.maxWidth).toMatch(new RegExp(`^min\\(${MENU_MAX_WIDTH}, `))
    for (const item of items()) {
      expect(item.className.split(/\s+/)).toEqual(expect.arrayContaining(['overflow-hidden', 'text-ellipsis']))
    }
  })
})
