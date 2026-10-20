// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: vi.fn(() => new Promise(() => {})), ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { StatusBar } from '@renderer/components/StatusBar'
import { STATUS_BAR_HEIGHT } from '@shared/layout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.innerHTML = '' })

// The window minimum reserves the fixed bars' heights from shared/layout, so each
// bar takes its height from there rather than from padding that could drift.
describe('fixed chrome heights', () => {
  it('gives the status bar the height the window minimum reserves', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(StatusBar)))
    expect(host.querySelector('footer')!.style.minHeight).toBe(`${STATUS_BAR_HEIGHT}px`)
    await act(async () => root.unmount())
  })
})
