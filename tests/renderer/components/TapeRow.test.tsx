// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: vi.fn(), ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { TapeRow } from '@renderer/components/TapeRow'
import type { Tape } from '@shared/domain'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A tape's title is the source's own text, so one that happens to read like a
// catalogue key is shown as it is; the setup's rendered-key gate must accept it.

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const tape: Tape = {
  id: 'Literal001', sourceUrl: 'https://example.test/watch', state: 'downloaded',
  addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
  title: 'settings.title', uploader: null, durationSeconds: 61, chapterCount: 0,
  probedAtUtc: null, filename: 'Literal001.mp4', sidecarFilename: 'Literal001.json', thumbnailFilename: null,
  downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: null, renamedAtUtc: null,
  archivedAtUtc: null, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
}

describe('TapeRow', () => {
  it('shows a title that reads like a catalogue key as the title it is', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(TapeRow, { tape, progress: undefined, selected: false, onSelect: () => {} })))
    expect(host.textContent).toContain('settings.title')
  })
})
