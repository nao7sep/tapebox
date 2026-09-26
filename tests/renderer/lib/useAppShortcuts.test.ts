// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { useAppShortcuts } from '@renderer/lib/useAppShortcuts'
import { useFilterStore } from '@renderer/store/filter'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let input: HTMLInputElement

function Harness() {
  useAppShortcuts(() => {})
  return null
}

beforeEach(async () => {
  input = document.createElement('input')
  document.body.append(input)
  root = createRoot(document.createElement('div'))
  await act(async () => root!.render(createElement(Harness)))
  useFilterStore.getState().setFilter('archived')
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

function pressCmd1(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true, cancelable: true, ...init })
  input.dispatchEvent(event)
  return event
}

describe('app shortcuts during IME composition', () => {
  it('Cmd+1 stands down while a candidate is pending, without swallowing the key', () => {
    const event = pressCmd1({ isComposing: true })
    expect(useFilterStore.getState().filter).toBe('archived')
    expect(event.defaultPrevented).toBe(false)
  })

  it('Cmd+1 switches to the Inbox once the composition has committed', () => {
    const event = pressCmd1()
    expect(useFilterStore.getState().filter).toBe('inbox')
    expect(event.defaultPrevented).toBe(true)
  })
})
