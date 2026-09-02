// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '@renderer/components/Modal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

type Overrides = {
  onClose?: () => void
  closeDisabled?: boolean
  footer?: ReactNode
}

async function mountModal(title: string, overrides: Overrides = {}): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      React.createElement(Modal, {
        title,
        onClose: overrides.onClose ?? (() => {}),
        closeDisabled: overrides.closeDisabled,
        footer: overrides.footer,
        children: React.createElement('p', null, 'Body content'),
      }),
    )
  })
}

async function unmount(): Promise<void> {
  if (root !== null) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
}

function dialog(): HTMLElement {
  const el = document.querySelector('[role="dialog"]')
  if (!(el instanceof HTMLElement)) {
    throw new Error('dialog surface not found')
  }
  return el
}

afterEach(async () => {
  await unmount()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

describe('Modal accessibility', () => {
  it('names the dialog by its title via aria-labelledby', async () => {
    await mountModal('Settings')
    const d = dialog()

    expect(d.getAttribute('aria-modal')).toBe('true')
    const labelledBy = d.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()

    const heading = document.getElementById(labelledBy!)
    expect(heading?.tagName).toBe('H2')
    expect(heading?.textContent).toBe('Settings')
  })

  it('keeps its header and footer fixed while only the body may shrink and scroll', async () => {
    await mountModal('Growing result', {
      footer: React.createElement('button', null, 'Close'),
    })
    const d = dialog()
    const header = d.querySelector('header')!
    const body = header.nextElementSibling as HTMLElement
    const footer = d.querySelector('footer')!

    expect(d.className).toContain('max-h-[85vh]')
    expect(header.className).toContain('shrink-0')
    expect(body.className).toContain('min-h-0')
    expect(body.className).toContain('overflow-y-auto')
    expect(footer.className).toContain('shrink-0')
  })

  it('draws a quiet header close control whose hit area appears on hover and focus', async () => {
    await mountModal('Settings')
    const close = dialog().querySelector<HTMLButtonElement>('header button[aria-label="Close"]')!

    expect(close.className).toContain('border-0')
    expect(close.className).toContain('bg-transparent')
    expect(close.className).toContain('hover:bg-zinc-800')
    expect(close.className).toContain('focus-visible:bg-zinc-800')
  })
})

describe('Modal focus management', () => {
  it('moves focus to the dialog surface on open', async () => {
    await mountModal('Scan a page')
    expect(document.activeElement).toBe(dialog())
  })

  it('restores focus to the opener on close', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await mountModal('Rename')
    expect(document.activeElement).toBe(dialog())

    await unmount()
    expect(document.activeElement).toBe(trigger)
  })

  it('traps Tab inside the dialog, wrapping from the last control to the first', async () => {
    await mountModal('Export', {
      footer: React.createElement(
        React.Fragment,
        null,
        React.createElement('button', null, 'Cancel'),
        React.createElement('button', null, 'Export'),
      ),
    })
    const d = dialog()
    const buttons = Array.from(d.querySelectorAll<HTMLElement>('button'))
    // Header ✕ is first in DOM order; the footer's Export button is last.
    const first = buttons[0]
    const last = buttons[buttons.length - 1]

    last.focus()
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))

    expect(document.activeElement).toBe(first)
  })
})

describe('Modal background scroll lock', () => {
  it('locks body scroll while open and restores it on close', async () => {
    document.body.style.overflow = 'scroll'

    await mountModal('Required tools')
    expect(document.body.style.overflow).toBe('hidden')

    await unmount()
    expect(document.body.style.overflow).toBe('scroll')
  })
})

describe('Modal Escape handling', () => {
  it('closes through onClose when Escape is pressed', async () => {
    const onClose = vi.fn()
    await mountModal('About', { onClose })

    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on Escape while a non-interruptible action holds it open', async () => {
    const onClose = vi.fn()
    await mountModal('Required tools', { onClose, closeDisabled: true })

    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close on Escape while an IME composition is in progress', async () => {
    const onClose = vi.fn()
    await mountModal('Scan a page', { onClose })

    // Escape during composition cancels the IME candidate; it must not close the modal.
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    expect(onClose).not.toHaveBeenCalled()

    // A plain Escape (no active composition) still closes.
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
