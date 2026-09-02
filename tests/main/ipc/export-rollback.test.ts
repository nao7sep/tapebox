import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
}))

const state = vi.hoisted(() => ({
  destinationDir: '', calls: 0, first: null as null | { path: string; identity: string }, cleanupThrows: false,
}))
const logError = vi.hoisted(() => vi.fn())
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    writeFileAtomicNoOverwriteVia: vi.fn(async (...args: Parameters<typeof actual.writeFileAtomicNoOverwriteVia>) => {
      state.calls += 1
      if (state.calls === 3) {
        const winner = join(state.destinationDir, 'external-export-winner.tmp')
        await writeFile(winner, 'external winner')
        await rename(winner, state.first!.path)
        throw new Error('sidecar publication failed')
      }
      const claim = await actual.writeFileAtomicNoOverwriteVia(...args)
      state.first ??= claim
      return claim
    }),
    unlinkClaimedFiles: vi.fn(async (...args: Parameters<typeof actual.unlinkClaimedFiles>) => {
      if (state.cleanupThrows) {
        throw new AggregateError(
          [new Error(`Recovery claim remains at ${join(state.destinationDir, 'export-recovery.tmp')}`)],
          'cleanup permission denied',
        )
      }
      return actual.unlinkClaimedFiles(...args)
    }),
  }
})

const tape: Tape = {
  id: 'Abc123_-xy', sourceUrl: 'https://example.test/watch', state: 'downloaded',
  addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
  title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
  probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
  sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg',
  downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
  name: 'Take', renamedAtUtc: null, archivedAtUtc: null, boxId: null, order: 0,
  pausedAtUtc: null, failedAtUtc: null, lastError: null,
}
const libraryState = vi.hoisted(() => ({ dir: '' }))
const sessionState = vi.hoisted(() => ({ tape: null as Tape | null }))
vi.mock('@main/store/session', () => ({ getTape: () => sessionState.tape }))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => libraryState.dir }))
vi.mock('@main/ipc/library', () => ({
  caseInsensitiveSiblingExists: vi.fn(async () => false),
  removeTapes: vi.fn(async () => ({ failed: [] })),
}))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }))

const { registerExportHandlers } = await import('@main/ipc/export')

let root: string

beforeEach(async () => {
  handlers.clear()
  logError.mockClear()
  state.calls = 0
  state.first = null
  state.cleanupThrows = false
  sessionState.tape = tape
  root = await mkdtemp(join(tmpdir(), 'tapebox-export-rollback-'))
  libraryState.dir = join(root, 'library')
  state.destinationDir = join(root, 'destination')
  await mkdir(libraryState.dir)
  await mkdir(state.destinationDir)
  await writeFile(join(libraryState.dir, 'Take.mp4'), 'source video')
  await writeFile(join(libraryState.dir, 'Take.jpg'), 'source poster')
  await writeFile(join(libraryState.dir, 'Take.json'), JSON.stringify({
    tapebox: {
      sourceUrl: tape.sourceUrl, name: 'Take', addedAtUtc: tape.addedAtUtc,
      downloadedAtUtc: tape.downloadedAtUtc, renamedAtUtc: null, media: null,
      mediaFilename: tape.filename, thumbnailFilename: tape.thumbnailFilename,
    },
  }))
  registerExportHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('export:files rollback ownership', () => {
  it('preserves a replacement winner and removes only still-owned committed members', async () => {
    const failure = handlers.get('export:files')!({
      tapeId: tape.id, destinationDir: state.destinationDir, name: 'Exported', deleteFromApp: false,
    })
    await expect(failure).rejects.toThrow('The operation could not be completed.')

    expect(await readFile(join(state.destinationDir, 'Exported.mp4'), 'utf8')).toBe('external winner')
    await expect(readFile(join(state.destinationDir, 'Exported.jpg'))).rejects.toThrow()
  })

  it('keeps rollback cleanup details in diagnostics while the rejection stays authored', async () => {
    state.cleanupThrows = true
    const failure = handlers.get('export:files')!({
      tapeId: tape.id, destinationDir: state.destinationDir, name: 'Exported', deleteFromApp: false,
    })

    await expect(failure).rejects.toThrow('The operation could not be completed.')
    expect(JSON.stringify(logError.mock.calls)).toContain('sidecar publication failed')
    expect(JSON.stringify(logError.mock.calls)).toContain('export-recovery.tmp')
  })
})
