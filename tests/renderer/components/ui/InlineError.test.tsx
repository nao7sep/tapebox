// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { InlineError } from '@renderer/components/ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

// The dismiss X sits on the first text line: a top-aligned flex row (never
// absolute positioning pinned to a fixed pixel offset), with the button's own
// margin-top derived from the message's line height so it centres on the
// first line whether the message is one line or wraps to several. Pins the
// mechanism (jsdom does not lay out real pixels, so this checks the recipe
// rather than a measured offset — see the Playwright evidence for that).
describe('InlineError dismiss control', () => {
  it('top-aligns the row and derives the button offset from the text line height', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      React.createElement(InlineError, { onDismiss: () => {}, children: 'Something went wrong.' }),
    ))

    const alert = container.querySelector('[role="alert"]')!
    expect(alert.className).toMatch(/\bflex\b/)
    expect(alert.className).toMatch(/\bitems-start\b/)
    expect(alert.className).not.toMatch(/\babsolute\b/)

    const button = alert.querySelector('button')!
    expect(button.className).not.toMatch(/\babsolute\b/)
    expect(button.style.marginTop).toBe('calc((var(--text-xs--line-height) - 1.5rem) / 2)')
  })
})
