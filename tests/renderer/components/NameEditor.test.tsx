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

const tape = { id: 't1', title: 'A Title', uploader: null, state: 'downloaded', sidecarFilename: 't1.json' } as Tape

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

  it('offers a visible retry after a provider failure', async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:generateSlug') return Promise.reject(new Error('provider failure'))
      return Promise.resolve({})
    })
    await act(async () => button('Suggest')!.click())
    expect(button('Try again')?.disabled).toBe(false)
    await act(async () => button('Try again')!.click())
    expect(ipcInvoke.mock.calls.filter(([channel]) => channel === 'ai:generateSlug')).toHaveLength(2)
  })

  it('cancels a running suggestion when the dialog closes', async () => {
    await act(async () => button('Suggest')!.click())
    const requestId = requestIdOf('ai:generateSlug')
    act(() => root!.unmount())
    root = null
    expect(requestIdOf('ai:cancelSlug')).toBe(requestId)
  })
})

async function renderTape(nextTape: Tape, value = 'my draft') {
  await act(async () => root!.render(createElement(NameEditor, { tape: nextTape, value, onChange, onGeneratingChange })))
}

describe('NameEditor description preview', () => {
  it('shows a retryable failure while keeping the draft and title-only Suggest usable', async () => {
    let reads = 0
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'library:getSidecar') {
        reads += 1
        return reads === 1 ? Promise.reject(new Error('EACCES /private/PREVIEW_SENTINEL')) : Promise.resolve({ description: 'A readable description' })
      }
      if (channel === 'ai:generateSlug') return Promise.resolve({ slug: 'a-title' })
      return Promise.resolve()
    })
    await renderTape({ ...tape, id: 'preview' })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The description could not be loaded.')
    expect(host.textContent).not.toContain('PREVIEW_SENTINEL')
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('my draft')
    expect(host.querySelectorAll('dt')).toHaveLength(1)
    expect(button('Suggest')?.disabled).toBe(false)
    await act(async () => button('Suggest')!.click())
    expect(ipcInvoke).toHaveBeenCalledWith('ai:generateSlug', expect.objectContaining({
      tapeId: 'preview', include: { title: true, uploader: false, description: false },
    }))
    await act(async () => button('Try again')!.click())
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('A readable description')
    expect(host.querySelectorAll('dt')).toHaveLength(2)
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('my draft')
  })

  it('treats a successfully loaded absent description as empty rather than failed', async () => {
    await renderTape({ ...tape, id: 'without-description' })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(button('Try again')).toBeUndefined()
    expect(host.querySelectorAll('dt')).toHaveLength(1)
  })

  it.each(['success', 'failure'])('ignores obsolete preview %s after the tape changes', async (outcome) => {
    let resolve!: (result: unknown) => void
    let reject!: (error: Error) => void
    const old = new Promise((yes, no) => { resolve = yes; reject = no })
    ipcInvoke.mockImplementation((channel: string, request?: { tapeId?: string }) => {
      if (channel === 'library:getSidecar') return request?.tapeId === 'old' ? old : Promise.resolve({ description: 'Current description' })
      return Promise.resolve()
    })
    await renderTape({ ...tape, id: 'old' })
    await renderTape({ ...tape, id: 'current' })
    await act(async () => outcome === 'success' ? resolve({ description: 'Obsolete description' }) : reject(new Error('obsolete error')))
    expect(host.textContent).toContain('Current description')
    expect(host.textContent).not.toContain('Obsolete description')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('cancels an old tape suggestion and prevents its response replacing the new draft', async () => {
    let finish!: (value: { slug: string }) => void
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:generateSlug') return new Promise((resolve) => { finish = resolve })
      return Promise.resolve({})
    })
    await act(async () => button('Suggest')!.click())
    const requestId = requestIdOf('ai:generateSlug')
    await renderTape({ ...tape, id: 'replacement', title: 'New title' }, 'new draft')
    expect(requestIdOf('ai:cancelSlug')).toBe(requestId)
    await act(async () => finish({ slug: 'obsolete-slug' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('new draft')
    expect(button('Suggest')?.disabled).toBe(false)
  })
})
