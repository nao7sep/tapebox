// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster } from '@renderer/components/Toaster'
import { useToastStore } from '@renderer/store/toast'
import { message } from '@shared/i18n/translate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
  useToastStore.setState({ toasts: [] })
})

describe('Toaster error results', () => {
  it('stacks persistent results as alerts without redundant severity labels', async () => {
    useToastStore.getState().notify(message('app.librarySaveFailed'), 'error')
    useToastStore.getState().notify(message('tapes.orderSaveFailed'), 'error')
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(React.createElement(Toaster)))

    const alerts = document.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]?.textContent).not.toContain('Error')
    expect(alerts[0]?.textContent).toContain('Library changes could not be saved to disk.')

    await act(async () => {
      alerts[0]?.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('The tape order was not saved.')
  })

  // The close X sits on the message's first line: a top-aligned flex row, with
  // the button's margin-top derived from the text-sm line height rather than an
  // absolute offset that only approximates it (same mechanism as InlineError).
  it('centres the close button on the first line via a derived margin, not an absolute offset', async () => {
    useToastStore.getState().notify(message('app.librarySaveFailed'), 'error')
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(React.createElement(Toaster)))

    const alert = document.querySelector('[role="alert"]')!
    expect(alert.className).toMatch(/\bflex\b/)
    expect(alert.className).toMatch(/\bitems-start\b/)
    expect(alert.className).not.toMatch(/\babsolute\b/)

    const button = alert.querySelector('button')!
    expect(button.className).not.toMatch(/\babsolute\b/)
    expect(button.style.marginTop).toBe('calc((var(--text-sm--line-height) - 1.75rem) / 2)')
  })
})
