// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: vi.fn(), ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { TapeRow } from '@renderer/components/TapeRow'
import { tapeStates, type Tape } from '@shared/domain'

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
  it.each(tapeStates)('keeps the selected %s row eligible for hover and a separate keyboard cue', async (state) => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const onSelect = vi.fn()
    await act(async () => root!.render(createElement(TapeRow, {
      tape: { ...tape, state }, progress: undefined, selected: true, onSelect,
    })))
    const row = host.querySelector<HTMLElement>('[role="option"]')!
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.classList.contains('listbox-item')).toBe(true)
    expect(row.classList.contains('tape-row')).toBe(true)
    expect(row.classList.contains('border-selected')).toBe(true)
    await act(async () => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows a title that reads like a catalogue key as the title it is', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(TapeRow, { tape, progress: undefined, selected: false, onSelect: () => {} })))
    expect(host.textContent).toContain('settings.title')
  })
})

// An untitled tape is named by its URL, which keeps its final segment: the
// beginning is the same site for many tapes (interface-styling-conventions).
describe('an untitled tape row', () => {
  it('shows its URL on one line, losing the shared beginning before the final segment', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const sourceUrl = 'https://www.example.test/channel/uploads/watch?v=Distinct42'
    await act(async () => root!.render(createElement(TapeRow, {
      tape: { ...tape, title: null, sourceUrl }, progress: undefined, selected: false, onSelect: vi.fn(),
    })))
    const parts = [...host.querySelectorAll<HTMLElement>('[data-literal] > span')]
    expect(parts.map((part) => part.textContent)).toEqual(['https://www.example.test/channel/uploads/', 'watch?v=Distinct42'])
    expect(parts[0]!.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    expect(parts[1]!.className.split(/\s+/)).toEqual(expect.arrayContaining(['shrink-0', 'max-w-full', 'truncate']))
  })
})
