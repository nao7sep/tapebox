// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { useAppShortcuts } from '@renderer/lib/useAppShortcuts'
import { useModifierWord } from '@renderer/lib/useModifierWord'
import { useFilterStore } from '@renderer/store/filter'
import { useRuntimeStore } from '@renderer/store/runtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let input: HTMLInputElement
let modifierWord = ''

function Harness() {
  useAppShortcuts(() => {})
  modifierWord = useModifierWord()
  return null
}

async function onPlatform(platform: 'darwin' | 'win32' | 'linux'): Promise<void> {
  await act(async () => useRuntimeStore.getState().setInfo({ platform, arch: 'x64', version: '0.0.0' } as never))
}

beforeEach(async () => {
  input = document.createElement('input')
  document.body.append(input)
  root = createRoot(document.createElement('div'))
  await act(async () => root!.render(createElement(Harness)))
  useFilterStore.getState().setFilter('shelf')
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  useRuntimeStore.setState({ info: null })
})

function pressCmd1(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true, cancelable: true, ...init })
  input.dispatchEvent(event)
  return event
}

describe('app shortcuts during IME composition', () => {
  it('Cmd+1 stands down while a candidate is pending, without swallowing the key', () => {
    const event = pressCmd1({ isComposing: true })
    expect(useFilterStore.getState().filter).toBe('shelf')
    expect(event.defaultPrevented).toBe(false)
  })

  it('Cmd+1 switches to the Inbox once the composition has committed', () => {
    const event = pressCmd1()
    expect(useFilterStore.getState().filter).toBe('inbox')
    expect(event.defaultPrevented).toBe(true)
  })
})

// The running platform decides the modifier: Cmd on macOS, Ctrl elsewhere. While
// typing on macOS, Ctrl belongs to the text system, so its chord stands down.
describe('app shortcuts per platform', () => {
  it('macOS names Cmd and lets Ctrl+1 reach the field while typing', async () => {
    await onPlatform('darwin')
    expect(modifierWord).toBe('Cmd')
    const event = pressCmd1({ metaKey: false, ctrlKey: true })
    expect(useFilterStore.getState().filter).toBe('shelf')
    expect(event.defaultPrevented).toBe(false)
  })

  it.each(['win32', 'linux'] as const)('%s names Ctrl and switches on Ctrl+1 while typing', async (platform) => {
    await onPlatform(platform)
    expect(modifierWord).toBe('Ctrl')
    const event = pressCmd1({ metaKey: false, ctrlKey: true })
    expect(useFilterStore.getState().filter).toBe('inbox')
    expect(event.defaultPrevented).toBe(true)
  })
})
