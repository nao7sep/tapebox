// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: vi.fn(), ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))
vi.mock('@renderer/lib/tapeActions', () => ({ moveTapeToBox: vi.fn() }))

import { MoveToBoxButton } from '@renderer/components/MoveToBoxButton'
import { moveTapeToBox } from '@renderer/lib/tapeActions'
import { useBoxesStore } from '@renderer/store/boxes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tape: Tape = {
  id: 'Selected01', sourceUrl: 'https://example.test/watch', state: 'downloaded',
  addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
  title: 'Selected tape', uploader: null, durationSeconds: 61, chapterCount: 0,
  probedAtUtc: null, filename: 'Selected01.mp4', sidecarFilename: 'Selected01.json', thumbnailFilename: null,
  downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: null, renamedAtUtc: null,
  archivedAtUtc: '2026-01-01T00:00:01.000Z', boxId: 'Selected02', order: 0,
  pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
}
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  useBoxesStore.setState({ boxes: [] })
  vi.clearAllMocks()
})

describe('MoveToBoxButton', () => {
  it('starts at the current box, keeps its checkmark while navigating, and acts on a clicked box', async () => {
    useBoxesStore.setState({ boxes: [
      { id: 'Selected01', name: 'Earlier box', order: 0 },
      { id: 'Selected02', name: 'Current box', order: 1 },
    ] })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(MoveToBoxButton, { tape })))
    await act(async () => host.querySelector('button')!.click())
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    expect(document.activeElement).toBe(options[2])
    expect(options[2]!.getAttribute('aria-checked')).toBe('true')
    expect(options[2]!.querySelector('svg')).not.toBeNull()
    await act(async () => options[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(document.activeElement).toBe(options[1])
    expect(options[2]!.getAttribute('aria-checked')).toBe('true')
    expect(options[2]!.querySelector('svg')).not.toBeNull()
    await act(async () => options[0]!.click())
    expect(moveTapeToBox).toHaveBeenCalledExactlyOnceWith(tape, null, 'tape')
  })
})
