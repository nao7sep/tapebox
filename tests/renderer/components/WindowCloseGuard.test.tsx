// @vitest-environment jsdom
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowCloseGuard } from '@renderer/components/WindowCloseGuard'
import { useWindowCloseGuard, isWindowClosePending } from '@renderer/lib/windowClose'

// Every quit, closing the main window included, asks before discarding the
// window's drafts (unsaved-edits-conventions); a minimized window only reports them.

type Request = { requestId: number; ask: boolean }
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), request: ((_: Request) => {}) as (request: Request) => void, stop: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({
  ipcInvoke: bridge.invoke,
  ipcOn: (_channel: string, listener: (request: Request) => void) => { bridge.request = listener; return bridge.stop },
}))
vi.mock('@renderer/ipc/log', () => ({ log: { warn: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let edit: (value: string) => void

function Editor() {
  const [value, setValue] = useState('original')
  edit = setValue
  useWindowCloseGuard(() => ({ dirty: value !== 'original' }))
  return <><input aria-label="draft" value={value} onChange={(event) => setValue(event.target.value)} /><WindowCloseGuard /></>
}

function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
}

const answers = () => bridge.invoke.mock.calls.filter(([channel]) => channel === 'app:quitDraftsAnswer').map(([, answer]) => answer)

beforeEach(async () => {
  vi.clearAllMocks()
  bridge.invoke.mockResolvedValue(true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(React.createElement(Editor)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('a quit and the window\'s drafts', () => {
  it('lets a quit go on without a question when nothing is unsaved', async () => {
    await act(async () => bridge.request({ requestId: 1, ask: true }))
    expect(answers()).toEqual([{ requestId: 1, dirty: false, discard: true }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('asks once, defaults to keeping the edits, and keeps them exactly', async () => {
    await act(async () => edit('  my unfinished name  '))
    await act(async () => bridge.request({ requestId: 2, ask: true }))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.activeElement).toBe(button('Keep editing'))
    expect(isWindowClosePending()).toBe(true)
    await act(async () => button('Keep editing').click())
    expect(answers()).toEqual([{ requestId: 2, dirty: true, discard: false }])
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('  my unfinished name  ')
    expect(isWindowClosePending()).toBe(false)
  })

  it('lets the quit discard the drafts on Discard, without submitting them', async () => {
    await act(async () => edit('unsaved'))
    await act(async () => bridge.request({ requestId: 3, ask: true }))
    await act(async () => button('Discard').click())
    expect(answers()).toEqual([{ requestId: 3, dirty: true, discard: true }])
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('unsaved')
  })

  it('only reports the drafts while minimized, for main to ask without showing the window', async () => {
    await act(async () => edit('unsaved'))
    await act(async () => bridge.request({ requestId: 4, ask: false }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(answers()).toEqual([{ requestId: 4, dirty: true, discard: false }])
  })
  it('does not show an expired question when the renderer responds late', async () => {
    await act(async () => edit('unsaved'))
    bridge.invoke.mockResolvedValueOnce(false)
    await act(async () => bridge.request({ requestId: 5, ask: true }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(answers()).toEqual([])
    expect(isWindowClosePending()).toBe(false)
  })

})
