vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { sidecarFixture } from '../../helpers/file-header'

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
}))

const state = vi.hoisted(() => ({ destinationDir: '', cleanupThrows: false }))
const logError = vi.hoisted(() => vi.fn())
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    writeFileAtomicNoOverwriteVia: vi.fn(async () => { throw new Error('sidecar publication failed') }),
    unlinkFiles: vi.fn(async (...args: Parameters<typeof actual.unlinkFiles>) => {
      if (state.cleanupThrows) {
        throw new AggregateError(
          [new Error(`Could not remove ${join(state.destinationDir, 'Exported.mp4')}`)],
          'cleanup permission denied',
        )
      }
      return actual.unlinkFiles(...args)
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
  name: 'Take', renamedAtUtc: null, addedIndex: 0, shelved: false, boxId: null, order: 0,
  pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
}
const collectionState = vi.hoisted(() => ({ dir: '' }))
const sessionState = vi.hoisted(() => ({ tape: null as Tape | null }))
vi.mock('@main/store/session', () => ({ getTape: () => sessionState.tape }))
vi.mock('@main/store/config', () => ({ getCollectionDir: () => collectionState.dir }))
vi.mock('@main/ipc/collection', () => ({ removeTapesFrom: vi.fn(async () => ({ removed: [], failed: [] as string[] })) }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }))

const { registerExportHandlers } = await import('@main/ipc/export')

let root: string

beforeEach(async () => {
  handlers.clear()
  logError.mockClear()
  state.cleanupThrows = false
  sessionState.tape = tape
  root = await mkdtemp(join(tmpdir(), 'tapebox-export-rollback-'))
  collectionState.dir = join(root, 'collection')
  state.destinationDir = join(root, 'destination')
  await mkdir(join(collectionState.dir, 'inbox', tape.id), { recursive: true })
  await mkdir(state.destinationDir)
  await writeFile(join(collectionState.dir, 'inbox', tape.id, 'Take.mp4'), 'source video')
  await writeFile(join(collectionState.dir, 'inbox', tape.id, 'Take.jpg'), 'source poster')
  await writeFile(join(collectionState.dir, 'inbox', tape.id, 'Take.json'), JSON.stringify(sidecarFixture()))
  registerExportHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('export:files rollback ownership', () => {
  it('removes every member it published when a later publication fails', async () => {
    const failure = handlers.get('export:files')!({
      tapeId: tape.id, destinationDir: state.destinationDir, name: 'Exported', deleteFromApp: false,
    })
    await expect(failure).rejects.toThrow('The operation could not be completed.')
    expect(await readdir(state.destinationDir)).toEqual([])
    expect(await readFile(join(collectionState.dir, 'inbox', tape.id, 'Take.mp4'), 'utf8')).toBe('source video')
  })

  it('keeps rollback cleanup details in diagnostics while the rejection stays authored', async () => {
    state.cleanupThrows = true
    const failure = handlers.get('export:files')!({
      tapeId: tape.id, destinationDir: state.destinationDir, name: 'Exported', deleteFromApp: false,
    })

    await expect(failure).rejects.toThrow('The operation could not be completed.')
    expect(JSON.stringify(logError.mock.calls)).toContain('sidecar publication failed')
    expect(JSON.stringify(logError.mock.calls)).toContain('Exported.mp4')
  })
})
