// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import type { RefreshedMetadata, SidecarRaw } from '@shared/ipc-contract'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { RefreshMetadataModal } from '@renderer/components/RefreshMetadataModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement

const tape: Tape = {
  id: 'Refresh001', sourceUrl: 'https://example.test/watch', state: 'downloaded',
  addedAtUtc: '2026-01-01T00:00:00.000Z', addedIndex: 0, sourceId: 'source', extractor: 'test',
  title: 'Saved title', uploader: 'Uploader', durationSeconds: 61, chapterCount: 0,
  probedAtUtc: null, filename: 'Refresh001.mp4', sidecarFilename: 'Refresh001.json', thumbnailFilename: null,
  downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: null, renamedAtUtc: null,
  shelved: false, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
}

const candidate: RefreshedMetadata = {
  title: 'Updated title', uploader: 'Uploader', description: null,
  probedAtUtc: '2026-01-02T00:00:00.000Z',
}

beforeEach(() => {
  ipcInvoke.mockReset()
  ipcInvoke.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

async function mount(onClose = vi.fn()): Promise<void> {
  root = createRoot(host)
  await act(async () => root!.render(createElement(RefreshMetadataModal, { tape, onClose })))
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`button "${text}" not found`)
  return found
}

async function checkSource(): Promise<void> {
  ipcInvoke.mockResolvedValueOnce(candidate)
  await act(async () => button('Check source').click())
}

describe('RefreshMetadataModal saved description comparison', () => {
  it('blocks Apply until the saved description is shown beside an empty source description', async () => {
    let finishLoad!: (sidecar: SidecarRaw) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve }))
    await mount()
    await checkSource()

    expect(button('Apply').disabled).toBe(true)
    await act(async () => button('Apply').click())
    expect(ipcInvoke.mock.calls.some(([channel]) => channel === 'collection:applyMetadata')).toBe(false)
    expect(host.textContent).toContain('Description')

    await act(async () => { finishLoad({ ytDlp: { description: 'Saved description that Apply would erase.' } }) })

    expect(host.textContent).toContain('Saved description that Apply would erase.')
    expect(button('Apply').disabled).toBe(false)
    const currentBox = [...host.querySelectorAll('[data-passive-scroll-region][aria-label="Description"]')].find((node) =>
      node.textContent === 'Saved description that Apply would erase.',
    )
    expect(currentBox?.nextElementSibling?.textContent).toBe('—')
    expect(currentBox?.nextElementSibling?.className).toContain('text-warning-fg')
  })

  it('keeps a failed saved-description load local and blocks Apply until Retry succeeds', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error('EACCES /private/tmp/TAPEBOX_REFRESH_SENTINEL'))
    await mount()
    await checkSource()

    expect(button('Apply').disabled).toBe(true)
    const alert = host.querySelector('[role="dialog"] [role="alert"]')
    expect(alert?.textContent).toContain('The saved description could not be loaded.')
    expect(alert?.textContent).not.toMatch(/EACCES|private\/tmp|TAPEBOX_REFRESH_SENTINEL/)
    expect(host.textContent).toContain('Description')
    expect(host.textContent).not.toContain('Up to date')

    ipcInvoke.mockResolvedValueOnce({ ytDlp: { description: 'Saved description' } })
    await act(async () => button('Retry').click())

    expect(ipcInvoke.mock.calls.filter(([channel]) => channel === 'collection:getSidecar')).toEqual([
      ['collection:getSidecar', { tapeId: tape.id }],
      ['collection:getSidecar', { tapeId: tape.id }],
    ])
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('Saved description')
    expect(button('Apply').disabled).toBe(false)
  })

  it('allows a known empty description and keeps the shared close guard while applying', async () => {
    const onClose = vi.fn()
    ipcInvoke.mockResolvedValueOnce({})
    await mount(onClose)
    await checkSource()
    expect(button('Apply').disabled).toBe(false)

    ipcInvoke.mockImplementationOnce(() => new Promise(() => {}))
    await act(async () => button('Apply').click())
    await act(async () => {
      host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      button('Cancel').click()
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})


it('cancels a closing editor probe and ignores its late reply after reopening', async () => {
  let finish!: (value: RefreshedMetadata) => void
  ipcInvoke.mockImplementation((channel) => {
    if (channel === 'collection:getSidecar') return Promise.resolve({})
    if (channel === 'collection:probeMetadata') return new Promise((resolve) => { finish = resolve })
    return Promise.resolve()
  })
  await mount()
  await act(async () => button('Check source').click())
  const firstRequest = ipcInvoke.mock.calls.find(([channel]) => channel === 'collection:probeMetadata')![1]
  await act(async () => root!.unmount())
  root = null
  expect(ipcInvoke).toHaveBeenCalledWith('collection:cancelMetadataProbe', { requestId: firstRequest.requestId })
  await mount()
  await act(async () => { finish(candidate) })
  expect(host.textContent).not.toContain(candidate.title)
  expect(button('Check source').disabled).toBe(false)
  await act(async () => button('Check source').click())
  const probes = ipcInvoke.mock.calls.filter(([channel]) => channel === 'collection:probeMetadata')
  expect(probes[1]![1].requestId).not.toBe(firstRequest.requestId)
})

it('still closes when the cancellation request fails', async () => {
  const onClose = vi.fn()
  ipcInvoke.mockImplementation((channel) => {
    if (channel === 'collection:getSidecar') return Promise.resolve({})
    if (channel === 'collection:probeMetadata') return new Promise(() => {})
    if (channel === 'collection:cancelMetadataProbe') return Promise.reject(new Error('closed IPC'))
    return Promise.resolve()
  })
  await mount(onClose)
  await act(async () => button('Check source').click())
  await act(async () => button('Cancel').click())
  expect(onClose).toHaveBeenCalledOnce()
  expect(ipcInvoke.mock.calls.filter(([channel]) => channel === 'collection:cancelMetadataProbe')).toHaveLength(1)
})
