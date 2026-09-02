import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TapeSchema, type Tape } from '@shared/domain'

const { ipcInvoke, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { archiveTape, moveTapeToBox } from '@renderer/lib/tapeActions'
import { useTapesStore } from '@renderer/store/tapes'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'

function tape(overrides: Partial<Tape> = {}): Tape {
  return TapeSchema.parse({
    id: 'TapeAction',
    sourceUrl: 'https://example.com/watch?v=tape',
    state: 'downloaded',
    addedAtUtc: '2026-09-03T00:00:00.000Z',
    sourceId: 'tape',
    extractor: null,
    title: 'Tape',
    uploader: null,
    durationSeconds: null,
    chapterCount: 0,
    probedAtUtc: null,
    filename: 'TapeAction.mp4',
    sidecarFilename: 'TapeAction.json',
    thumbnailFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-09-03T00:00:00.000Z',
    name: null,
    renamedAtUtc: null,
    archivedAtUtc: null,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    lastError: null,
    ...overrides,
  })
}

beforeEach(() => {
  ipcInvoke.mockReset()
  logError.mockReset()
  useTapesStore.setState({ tapes: [], progress: {} })
  useTapeActionResultsStore.setState({ byTape: {} })
  useSelectionStore.setState({ selectedId: null })
  useFilterStore.setState({ filter: 'inbox' })
  useArchiveStore.setState({ selectedBoxId: null, query: '', pendingSearchFocus: false })
})

describe('archive and placement settlement', () => {
  it('rolls a rejected archive back and keeps a safe result with the tape', async () => {
    const original = tape()
    useTapesStore.setState({ tapes: [original] })
    useSelectionStore.setState({ selectedId: original.id })
    ipcInvoke.mockRejectedValueOnce(new Error('EACCES /private/tmp/TAPEBOX_ARCHIVE_SENTINEL'))

    archiveTape(original, 'tape')
    expect(useTapesStore.getState().tapes[0]?.archivedAtUtc).not.toBeNull()

    await vi.waitFor(() => expect(useTapesStore.getState().tapes[0]).toEqual(original))
    expect(useFilterStore.getState().filter).toBe('inbox')
    const message = useTapeActionResultsStore.getState().byTape[original.id]?.archive
    expect(message).toBe('This tape could not be archived. It remains in the Inbox; try again.')
    expect(message).not.toMatch(/EACCES|private\/tmp|SENTINEL/i)
    expect(JSON.stringify(logError.mock.calls)).toContain('TAPEBOX_ARCHIVE_SENTINEL')
  })

  it('rolls a rejected box placement back without clearing another tape action result', async () => {
    const original = tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z', boxId: null })
    useTapesStore.setState({ tapes: [original] })
    useTapeActionResultsStore.getState().setResult(original.id, 'reveal', 'Reveal remains unresolved')
    ipcInvoke.mockRejectedValueOnce(new Error('hostile placement diagnostic'))

    moveTapeToBox(original, 'BoxTarget1', 'list')
    await vi.waitFor(() => expect(useTapesStore.getState().tapes[0]).toEqual(original))

    expect(useTapeActionResultsStore.getState().byTape[original.id]).toEqual({
      reveal: 'Reveal remains unresolved',
      placement: 'This tape could not be moved to that box. Its previous location remains in use; try again.',
    })
  })
})
