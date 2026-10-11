// @vitest-environment jsdom
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowCloseGuard } from '@renderer/components/WindowCloseGuard'
import { useWindowCloseGuard, isWindowClosePending } from '@renderer/lib/windowClose'
import { Modal } from '@renderer/components/Modal'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), closeRequest: (() => {}) as () => void, stop: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({
  ipcInvoke: bridge.invoke,
  ipcOn: (_channel: string, listener: () => void) => { bridge.closeRequest = listener; return bridge.stop },
}))
vi.mock('@renderer/ipc/log', () => ({ log: { warn: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let busy = false
let edit: (value: string) => void

function Editor() {
  const [value, setValue] = useState('original')
  edit = setValue
  useWindowCloseGuard(() => ({ dirty: value !== 'original', busy }))
  return <><input aria-label="draft" value={value} onChange={(event) => setValue(event.target.value)} /><WindowCloseGuard /></>
}

function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
}

beforeEach(async () => {
  vi.clearAllMocks()
  bridge.invoke.mockResolvedValue(undefined)
  busy = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(React.createElement(Editor)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('window close draft consent', () => {
  it('approves a clean close without a question', async () => {
    await act(async () => bridge.closeRequest())
    expect(bridge.invoke).toHaveBeenCalledWith('app:closeWindow')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps exact edits, coalesces repeated requests, and defaults to keeping them', async () => {
    await act(async () => edit('  my unfinished name  '))
    await act(async () => { bridge.closeRequest(); bridge.closeRequest() })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.activeElement).toBe(button('Keep editing'))
    expect(isWindowClosePending()).toBe(true)
    await act(async () => button('Keep editing').click())
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('  my unfinished name  ')
    expect(bridge.invoke).not.toHaveBeenCalled()
    expect(isWindowClosePending()).toBe(false)
  })

  it('approves discard without submitting the edit', async () => {
    await act(async () => edit('unsaved'))
    await act(async () => bridge.closeRequest())
    await act(async () => button('Discard').click())
    expect(bridge.invoke.mock.calls).toEqual([['app:closeWindow']])
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('unsaved')
  })

  it('blocks a submitted operation, preserves its failed draft, and rechecks busy before discard', async () => {
    await act(async () => edit('failed rename'))
    busy = true
    await act(async () => bridge.closeRequest())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(bridge.invoke).not.toHaveBeenCalled()
    busy = false
    await act(async () => bridge.closeRequest())
    busy = true
    await act(async () => button('Discard').click())
    expect(bridge.invoke).not.toHaveBeenCalled()
    busy = false
    await act(async () => button('Keep editing').click())
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('failed rename')
  })

  it('inherits the busy guard of other modals', async () => {
    await act(async () => root.render(<><Modal title="Adding" onClose={() => {}} closeDisabled>Work</Modal><WindowCloseGuard /></>))
    await act(async () => bridge.closeRequest())
    expect(bridge.invoke).not.toHaveBeenCalled()
  })
})
