// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RowMoveMenu } from '@renderer/components/RowMoveMenu'
import { useRuntimeStore } from '@renderer/store/runtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  host.remove()
  document.body.innerHTML = ''
  useRuntimeStore.setState({ info: null })
})

function render(props: {
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  return act(async () => root?.render(React.createElement(RowMoveMenu, props)))
}

function openMenu(): void {
  const trigger = host.querySelector('button') as HTMLButtonElement
  act(() => trigger.click())
}

describe('RowMoveMenu', () => {
  it('renders no trigger when neither direction is available', async () => {
    await render({ canMoveUp: false, canMoveDown: false, onMoveUp: vi.fn(), onMoveDown: vi.fn() })
    expect(host.querySelector('button')).toBeNull()
  })

  it('shows only the reachable direction at a list boundary', async () => {
    await render({ canMoveUp: false, canMoveDown: true, onMoveUp: vi.fn(), onMoveDown: vi.fn() })
    openMenu()
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent)
    expect(labels.some((l) => l?.includes('Move up'))).toBe(false)
    expect(labels.some((l) => l?.includes('Move down'))).toBe(true)
  })

  it('shows the reorder chord for the running platform and fires the matching callback', async () => {
    useRuntimeStore.setState({ info: { platform: 'darwin', arch: 'arm64', version: '1' } })
    const onMoveUp = vi.fn()
    const onMoveDown = vi.fn()
    await render({ canMoveUp: true, canMoveDown: true, onMoveUp, onMoveDown })
    openMenu()

    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
    expect(items[0]?.querySelector('kbd')?.textContent).toBe('Cmd+Shift+Up')
    expect(items[1]?.querySelector('kbd')?.textContent).toBe('Cmd+Shift+Down')

    act(() => (items[1] as HTMLButtonElement).click())
    expect(onMoveDown).toHaveBeenCalledOnce()
    expect(onMoveUp).not.toHaveBeenCalled()
  })

  it('shows Ctrl on a non-Mac platform', async () => {
    useRuntimeStore.setState({ info: { platform: 'win32', arch: 'x64', version: '1' } })
    await render({ canMoveUp: true, canMoveDown: true, onMoveUp: vi.fn(), onMoveDown: vi.fn() })
    openMenu()
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
    expect(items[0]?.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+Up')
  })
})
