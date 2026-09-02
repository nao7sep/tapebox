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
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))

const state = vi.hoisted(() => ({
  libraryDir: '',
  calls: 0,
  failCall: 2 as number | null,
  failureMode: 'publication' as 'publication' | 'plain',
  first: null as null | { path: string; identity: string },
  cleanupThrows: false,
}))
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    writeFileAtomicNoOverwriteVia: vi.fn(async (...args: Parameters<typeof actual.writeFileAtomicNoOverwriteVia>) => {
      state.calls += 1
      if (state.calls === state.failCall) {
        if (state.failureMode === 'plain') throw new Error('thumbnail permission denied')
        const winner = join(state.libraryDir, 'external-import-winner.tmp')
        await writeFile(winner, 'external winner')
        await rename(winner, state.first!.path)
        throw new Error('sidecar publication failed')
      }
      const claim = await actual.writeFileAtomicNoOverwriteVia(...args)
      state.first = claim
      return claim
    }),
    unlinkClaimedFiles: vi.fn(async (...args: Parameters<typeof actual.unlinkClaimedFiles>) => {
      if (state.cleanupThrows) {
        throw new AggregateError(
          [new Error(`Recovery claim remains at ${join(state.libraryDir, 'import-recovery.tmp')}`)],
          'cleanup permission denied',
        )
      }
      return actual.unlinkClaimedFiles(...args)
    }),
  }
})

const upsertTape = vi.hoisted(() => vi.fn((_tape: Tape) => {}))
vi.mock('@main/store/session', () => ({
  getTape: () => undefined,
  getTapes: () => [],
  getBoxes: () => [],
  upsertTape,
  removeTapes: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: true, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ clearPartials: vi.fn(), downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
const mainLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: mainLog }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

let root: string
let sourceDir: string

beforeEach(async () => {
  handlers.clear()
  state.calls = 0
  state.failCall = 2
  state.failureMode = 'publication'
  state.first = null
  state.cleanupThrows = false
  mainLog.error.mockReset()
  root = await mkdtemp(join(tmpdir(), 'tapebox-import-rollback-'))
  sourceDir = join(root, 'source')
  state.libraryDir = join(root, 'library')
  await mkdir(sourceDir)
  await mkdir(state.libraryDir)
  await writeFile(join(sourceDir, 'clip.mp4'), 'source video')
  await writeFile(join(sourceDir, 'clip.json'), JSON.stringify({
    tapebox: {
      sourceUrl: 'https://example.test/clip', name: 'Clip',
      addedAtUtc: '2026-01-01T00:00:00.000Z', downloadedAtUtc: '2026-01-01T00:00:00.000Z',
      renamedAtUtc: null, media: null, mediaFilename: 'clip.mp4', thumbnailFilename: null,
    },
  }))
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('library:import rollback ownership', () => {
  it('preserves a replacement winner when a later bundle publication fails', async () => {
    const result = await handlers.get('library:import')!({
      paths: [join(sourceDir, 'clip.json'), join(sourceDir, 'clip.mp4')],
    }) as {
      imported: Tape[]
      issues: { reason: string }[]
    }

    expect(result.imported).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.reason).toBe(
      'The tape files could not be copied completely. Check the library folder and the log before trying again.',
    )
    expect(await readFile(join(state.libraryDir, 'clip.mp4'), 'utf8')).toBe('external winner')
    expect(upsertTape).not.toHaveBeenCalled()
    expect(mainLog.error).toHaveBeenCalledWith(
      'import bundle copy and rollback failed',
      expect.objectContaining({ error: expect.objectContaining({ stack: expect.any(String) }) }),
    )
  })

  it('surfaces a thrown rollback cleanup together with the initiating failure', async () => {
    state.cleanupThrows = true
    const result = await handlers.get('library:import')!({ paths: [join(sourceDir, 'clip.json')] }) as {
      imported: Tape[]
      issues: { reason: string }[]
    }

    expect(result.imported).toEqual([])
    expect(result.issues[0]?.reason).toBe(
      'The tape files could not be copied completely. Check the library folder and the log before trying again.',
    )
    expect(result.issues[0]?.reason).not.toMatch(/sidecar|private|import-recovery/)
    expect(mainLog.error).toHaveBeenCalledWith(
      'import bundle copy and rollback failed',
      expect.objectContaining({
        error: expect.objectContaining({ stack: expect.stringContaining('sidecar publication failed') }),
      }),
    )
  })

  it('imports the tape but accounts for and logs a referenced thumbnail copy failure', async () => {
    state.failCall = 3
    state.failureMode = 'plain'
    await writeFile(join(sourceDir, 'poster.jpg'), 'source poster')
    await writeFile(join(sourceDir, 'clip.json'), JSON.stringify({
      tapebox: {
        sourceUrl: 'https://example.test/clip', name: 'Clip',
        addedAtUtc: '2026-01-01T00:00:00.000Z', downloadedAtUtc: '2026-01-01T00:00:00.000Z',
        renamedAtUtc: null, media: null, mediaFilename: 'clip.mp4', thumbnailFilename: 'poster.jpg',
      },
    }))

    const result = await handlers.get('library:import')!({
      paths: [
        join(sourceDir, 'clip.json'),
        join(sourceDir, 'clip.mp4'),
        join(sourceDir, 'poster.jpg'),
      ],
    }) as { imported: Tape[]; issues: Array<{ path: string; reason: string; severity: string }> }

    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]?.thumbnailFilename).toBeNull()
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: join(sourceDir, 'poster.jpg'),
        reason: expect.stringContaining('thumbnail could not be copied'),
        severity: 'error',
      }),
    ])
    expect(mainLog.error).toHaveBeenCalledWith(
      'import thumbnail copy failed',
      expect.objectContaining({ error: expect.objectContaining({ stack: expect.any(String) }) }),
    )
  })
})
