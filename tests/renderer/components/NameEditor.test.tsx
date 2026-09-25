// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { NameEditor } from '@renderer/components/NameEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement
const onChange = vi.fn()
const onGeneratingChange = vi.fn()

const tape = { id: 't1', title: 'A Title', uploader: null } as Tape

beforeEach(async () => {
  ipcInvoke.mockReset()
  onChange.mockReset()
  onGeneratingChange.mockReset()
  ipcInvoke.mockImplementation((channel: string) => {
    if (channel === 'library:getSidecar') return Promise.resolve({})
    if (channel === 'ai:generateSlug') return new Promise(() => {}) // a provider that never answers
    return Promise.resolve()
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(NameEditor, { tape, value: '', onChange, onGeneratingChange })))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent === label)
}

function requestIdOf(channel: string): string | undefined {
  const call = ipcInvoke.mock.calls.find(([c]) => c === channel)
  return (call?.[1] as { requestId?: string } | undefined)?.requestId
}

describe('NameEditor suggestion', () => {
  it('offers Stop while a suggestion runs and cancels that request', async () => {
    await act(async () => button('Suggest')!.click())
    const requestId = requestIdOf('ai:generateSlug')
    expect(requestId).toBeTruthy()
    expect(button('Stop')?.disabled).toBe(false)

    await act(async () => button('Stop')!.click())

    expect(requestIdOf('ai:cancelSlug')).toBe(requestId)
    expect(button('Suggest')).toBeDefined()
    expect(onGeneratingChange).toHaveBeenLastCalledWith(false)
  })

  it('cancels a running suggestion when the dialog closes', async () => {
    await act(async () => button('Suggest')!.click())
    const requestId = requestIdOf('ai:generateSlug')
    act(() => root!.unmount())
    root = null
    expect(requestIdOf('ai:cancelSlug')).toBe(requestId)
  })
})
