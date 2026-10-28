import { invalidateTapeActions, runTapeAction } from '@renderer/lib/runTapeAction'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TapeSchema, type Tape } from '@shared/domain'

const { ipcInvoke, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { advanceSelection, archiveTape, unarchiveTape, moveTapeToBox } from '@renderer/lib/tapeActions'
import { useTapesStore } from '@renderer/store/tapes'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'
import { inEnglish, inEnglishAll } from '../../helpers/i18n'
import { message } from '@shared/i18n/translate'
import { until } from '../../helpers/until'

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
    failureCode: null,
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
  it('does not roll matching copied rows back after a collection change', async () => {
    let fail!: (reason: Error) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const original = tape()
    useTapesStore.setState({ tapes: [original] })
    archiveTape(original, 'tape')
    const copied = { ...useTapesStore.getState().tapes[0]!, title: 'Different collection' }
    invalidateTapeActions()
    useTapesStore.setState({ tapes: [copied] })
    fail(new Error('late archive failure'))
    await until(() => expect(logError).toHaveBeenCalled())
    expect(useTapesStore.getState().tapes).toEqual([copied])
    expect(useTapeActionResultsStore.getState().byTape).toEqual({})
  })

  it('rolls a rejected archive back and keeps a safe result with the tape', async () => {
    const original = tape()
    useTapesStore.setState({ tapes: [original] })
    useSelectionStore.setState({ selectedId: original.id })
    ipcInvoke.mockRejectedValueOnce(new Error('EACCES /private/tmp/TAPEBOX_ARCHIVE_SENTINEL'))

    archiveTape(original, 'tape')
    expect(useTapesStore.getState().tapes[0]?.archivedAtUtc).not.toBeNull()

    await until(() => expect(useTapesStore.getState().tapes[0]).toEqual(original))
    expect(useFilterStore.getState().filter).toBe('inbox')
    const shown = inEnglish(useTapeActionResultsStore.getState().byTape[original.id]?.archive)
    expect(shown).toBe('This tape could not be archived. It remains in the Inbox; try again.')
    expect(shown).not.toMatch(/EACCES|private\/tmp|SENTINEL/i)
    expect(JSON.stringify(logError.mock.calls)).toContain('TAPEBOX_ARCHIVE_SENTINEL')
  })

  it('rolls a rejected box placement back without clearing another tape action result', async () => {
    const original = tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z', boxId: null })
    useTapesStore.setState({ tapes: [original] })
    useTapeActionResultsStore.getState().setResult(original.id, 'reveal', message('detail.revealFailed'))
    ipcInvoke.mockRejectedValueOnce(new Error('hostile placement diagnostic'))

    moveTapeToBox(original, 'BoxTarget1', 'list')
    await until(() => expect(useTapesStore.getState().tapes[0]).toEqual(original))

    expect(inEnglishAll(useTapeActionResultsStore.getState().byTape[original.id])).toEqual({
      reveal: 'This tape could not be shown in its folder. The tape is unchanged; try again.',
      placement: 'This tape could not be moved to that box. Its previous location remains in use; try again.',
    })
  })
})

describe.each([
  { action: 'archive' as const, original: () => tape({ order: 10 }), invoke: (original: Tape) => archiveTape(original, 'tape') },
  { action: 'unarchive' as const, original: () => tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z', boxId: 'BoxSource1', order: 10 }), invoke: (original: Tape) => unarchiveTape(original, 'tape') },
  { action: 'placement' as const, original: () => tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z', boxId: 'BoxSource1', order: 10 }), invoke: (original: Tape) => moveTapeToBox(original, 'BoxTarget1', 'tape') },
])('$action rollback owns only its organization fields', ({ action, original: makeOriginal, invoke }) => {
  it('preserves metadata and renamed files received while persistence was pending', async () => {
    const original = makeOriginal()
    useTapesStore.getState().setAll([original])
    useSelectionStore.getState().select(original.id)
    let reject!: (reason: Error) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    invoke(original)

    const updated = {
      ...useTapesStore.getState().tapes[0]!,
      title: 'Updated title',
      name: 'new-name',
      filename: 'new-name.mp4',
      sidecarFilename: 'new-name.json',
      renamedAtUtc: '2026-09-03T00:00:01.000Z',
      durationSeconds: 123,
    }
    useTapesStore.getState().upsert(updated)
    reject(new Error('organization write rejected'))

    await until(() => expect(useTapesStore.getState().tapes[0]).toEqual({
      ...updated,
      archivedAtUtc: original.archivedAtUtc,
      boxId: original.boxId,
      order: original.order,
    }))
    expect(useTapeActionResultsStore.getState().byTape[original.id]?.[action]).toBeDefined()
    expect(useSelectionStore.getState().selectedId).toBe(original.id)
    expect(useFilterStore.getState().filter).toBe(original.archivedAtUtc ? 'archived' : 'inbox')
    if (original.archivedAtUtc) expect(useArchiveStore.getState().selectedBoxId).toBe(original.boxId)
  })

  it('preserves a newer order while restoring the failed location', async () => {
    const original = makeOriginal()
    useTapesStore.getState().setAll([original])
    let reject!: (reason: Error) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    invoke(original)
    useTapesStore.getState().upsert({ ...useTapesStore.getState().tapes[0]!, order: 77 })
    reject(new Error('organization write rejected'))

    await until(() => expect(useTapesStore.getState().tapes[0]).toEqual({ ...original, order: 77 }))
    expect(useTapeActionResultsStore.getState().byTape[original.id]?.[action]).toBeDefined()
  })
})

describe('relocation supersession and authoritative updates', () => {
  it('keeps the destination and its order together after a newer location arrives', async () => {
    const original = tape()
    useTapesStore.getState().setAll([original])
    useSelectionStore.getState().select(original.id)
    let reject!: (reason: Error) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    archiveTape(original, 'tape')
    const placed = { ...useTapesStore.getState().tapes[0]!, boxId: 'BoxTarget1', order: -10 }
    useTapesStore.getState().upsert(placed)
    reject(new Error('earlier archive rejected'))

    await until(() => expect(useTapeActionResultsStore.getState().byTape[original.id]?.archive).toBeDefined())
    expect(useTapesStore.getState().tapes[0]).toEqual(placed)
    expect(useFilterStore.getState().filter).toBe('archived')
  })

  it('does not resurrect a tape removed while its placement was pending', async () => {
    const original = tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z' })
    useTapesStore.getState().setAll([original])
    let reject!: (reason: Error) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    moveTapeToBox(original, 'BoxTarget1', 'list')
    useTapesStore.getState().removeMany([original.id])
    reject(new Error('placement rejected'))

    await until(() => expect(useTapeActionResultsStore.getState().byTape[original.id]?.placement).toBeDefined())
    expect(useTapesStore.getState().tapes).toEqual([])
  })

  it('leaves the main update in place after placement succeeds', async () => {
    const original = tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z' })
    useTapesStore.getState().setAll([original])
    let resolve!: () => void
    ipcInvoke.mockImplementationOnce(() => new Promise<void>((succeed) => { resolve = succeed }))
    moveTapeToBox(original, 'BoxTarget1', 'list')
    const confirmed = { ...useTapesStore.getState().tapes[0]!, title: 'Main title', order: -5 }
    useTapesStore.getState().upsert(confirmed)
    resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(useTapesStore.getState().tapes[0]).toEqual(confirmed)
    expect(useTapeActionResultsStore.getState().byTape[original.id]?.placement).toBeUndefined()
  })

  it('ignores an older rejected placement after a newer placement was submitted', async () => {
    const original = tape({ archivedAtUtc: '2026-09-03T00:00:00.000Z' })
    useTapesStore.getState().setAll([original])
    let rejectOlder!: (reason: Error) => void
    let resolveNewer!: () => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { rejectOlder = fail }))
    moveTapeToBox(original, 'BoxTarget1', 'list')
    ipcInvoke.mockImplementationOnce(() => new Promise<void>((succeed) => { resolveNewer = succeed }))
    moveTapeToBox(useTapesStore.getState().tapes[0]!, 'BoxTarget2', 'list')
    const latest = useTapesStore.getState().tapes[0]
    rejectOlder(new Error('older placement rejected'))
    await until(() => expect(logError).toHaveBeenCalled())

    expect(useTapesStore.getState().tapes[0]).toEqual(latest)
    expect(useTapeActionResultsStore.getState().byTape[original.id]?.placement).toBeUndefined()
    resolveNewer()
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('selection after an action settles', () => {
  it('moves to the neighbour only while the leaving tape is still the one selected', () => {
    const leaving = tape({ id: 'Leaving001', order: 0 })
    const next = tape({ id: 'Neighbour1', order: 1 })
    const other = tape({ id: 'Elsewhere1', order: 2 })
    useTapesStore.setState({ tapes: [leaving, next, other] })
    useSelectionStore.setState({ selectedId: leaving.id })

    const advance = advanceSelection(leaving)
    // The user moves on, say to rename another tape, while the removal is still running.
    useSelectionStore.getState().select(other.id)
    advance()
    expect(useSelectionStore.getState().selectedId).toBe(other.id)

    useSelectionStore.getState().select(leaving.id)
    advanceSelection(leaving)()
    expect(useSelectionStore.getState().selectedId).toBe(next.id)
  })

  it('returns a tape whose archive failed to view only while it is still selected', async () => {
    const archived = tape({ id: 'Archived01' })
    const other = tape({ id: 'Elsewhere2', order: 1 })
    useTapesStore.setState({ tapes: [archived, other] })
    useSelectionStore.setState({ selectedId: archived.id })
    let reject!: (error: Error) => void
    ipcInvoke.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))

    archiveTape(archived, 'tape')
    useSelectionStore.getState().select(other.id)
    reject(new Error('archive failed'))
    await until(() => expect(useTapesStore.getState().tapes.find((t) => t.id === archived.id)?.archivedAtUtc).toBeNull())
    expect(useSelectionStore.getState().selectedId).toBe(other.id)
  })
})


it('retiring an older attempt does not retire the newer command', async () => {
  let finish!: () => void
  let fail!: (error: Error) => void
  const first = runTapeAction('ownership', 'reveal', 'reveal', message('detail.revealFailed'), () => new Promise<void>(resolve => { finish = resolve }))
  const second = runTapeAction('ownership', 'reveal', 'reveal', message('detail.revealFailed'), () => new Promise<void>((_resolve, reject) => { fail = reject }))
  finish()
  await expect(first).resolves.toBe('superseded')
  fail(new Error('new command failed'))
  await expect(second).resolves.toBe('failed')
  expect(useTapeActionResultsStore.getState().byTape.ownership?.reveal).toBeDefined()
  await expect(runTapeAction('ownership', 'reveal', 'reveal', message('detail.revealFailed'), async () => {})).resolves.toBe('succeeded')
})
