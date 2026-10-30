import { librarySourceIndex } from '@shared/source-identity'
import type { SourceRef } from '@shared/source-identity'
vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import type { Message } from '@shared/i18n/translate'
import { inEnglish } from '../../helpers/i18n'

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))

const state = vi.hoisted(() => ({
  libraryDir: '',
  failSidecar: true,
  failCopyOf: null as string | null,
  cleanupThrows: false,
}))
// The bundle's media is copied before its sidecar is written into the new tape
// folder, so a failing sidecar write finds a published media copy to roll back.
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeJsonAtomic: vi.fn(async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      if (state.failSidecar && args[0].startsWith(state.libraryDir)) throw new Error('sidecar publication failed')
      return actual.writeJsonAtomic(...args)
    }),
  }
})
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    copyFileNoOverwrite: vi.fn(async (...args: Parameters<typeof actual.copyFileNoOverwrite>) => {
      if (basename(args[1]) === state.failCopyOf) throw new Error('thumbnail permission denied')
      return actual.copyFileNoOverwrite(...args)
    }),
  }
})
// The rollback removes the new tape folder whole.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (state.cleanupThrows) throw new Error(`Could not remove ${String(args[0])}: cleanup permission denied`)
      return actual.rm(...args)
    }),
  }
})

const upsertTape = vi.hoisted(() => vi.fn((_tape: Tape) => {}))
vi.mock('@main/store/session', () => ({
  sourceOwner: (ref: SourceRef, exceptId?: string) => librarySourceIndex([], exceptId).find(ref),
  onCatalogSaveFailure: () => {},
  persistNow: vi.fn(async () => {}),
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
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
const mainLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: mainLog }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

let root: string
let sourceDir: string

beforeEach(async () => {
  handlers.clear()
  state.failSidecar = true
  state.failCopyOf = null
  state.cleanupThrows = false
  mainLog.error.mockReset()
  root = await mkdtemp(join(tmpdir(), 'tapebox-import-rollback-'))
  sourceDir = join(root, 'source')
  state.libraryDir = join(root, 'library')
  await mkdir(sourceDir)
  await mkdir(state.libraryDir)
  await writeFile(join(sourceDir, 'clip.mp4'), 'source video')
  await writeFile(join(sourceDir, 'clip.json'), JSON.stringify({
    formatVersion: 1,
    tapebox: {
      sourceUrl: 'https://example.test/clip', name: 'Clip',
      addedAtUtc: '2026-01-01T00:00:00.000Z', downloadedAtUtc: '2026-01-01T00:00:00.000Z',
      renamedAtUtc: null, media: null, mediaFilename: 'clip.mp4', thumbnailFilename: null,
    },
  }))
  registerLibraryHandlers()
})

afterEach(async () => {
  state.cleanupThrows = false
  await rm(root, { recursive: true, force: true })
})

describe('library:import rollback ownership', () => {
  it('removes the files it copied when a later bundle publication fails', async () => {
    const result = await handlers.get('library:import')!({
      paths: [join(sourceDir, 'clip.json'), join(sourceDir, 'clip.mp4')],
    }) as {
      imported: Tape[]
      issues: { reason: Message }[]
    }

    expect(result.imported).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(inEnglish(result.issues[0]?.reason)).toBe(
      'The tape files could not be copied into the library. Check that the library folder is available and try again.',
    )
    expect(await readdir(state.libraryDir)).toEqual([])
    expect(upsertTape).not.toHaveBeenCalled()
    expect(mainLog.error).toHaveBeenCalledWith(
      'import bundle copy failed',
      expect.objectContaining({ error: expect.objectContaining({ stack: expect.any(String) }) }),
    )
  })

  it('surfaces a thrown rollback cleanup together with the initiating failure', async () => {
    state.cleanupThrows = true
    const result = await handlers.get('library:import')!({ paths: [join(sourceDir, 'clip.json')] }) as {
      imported: Tape[]
      issues: { reason: Message }[]
    }

    expect(result.imported).toEqual([])
    expect(inEnglish(result.issues[0]?.reason)).toBe(
      'The tape files could not be copied completely. Check the library folder and the log before trying again.',
    )
    expect(inEnglish(result.issues[0]?.reason)).not.toMatch(/sidecar|clip\.mp4/)
    expect(mainLog.error).toHaveBeenCalledWith(
      'import bundle copy and rollback failed',
      expect.objectContaining({
        error: expect.objectContaining({ stack: expect.stringContaining('sidecar publication failed') }),
      }),
    )
  })

  it('imports the tape but accounts for and logs a referenced thumbnail copy failure', async () => {
    state.failSidecar = false
    state.failCopyOf = 'poster.jpg'
    await writeFile(join(sourceDir, 'poster.jpg'), 'source poster')
    await writeFile(join(sourceDir, 'clip.json'), JSON.stringify({
      formatVersion: 1,
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
    }) as { imported: Tape[]; issues: Array<{ path: string; reason: Message; severity: string }> }
    const issues = result.issues.map((issue) => ({ ...issue, reason: inEnglish(issue.reason) }))

    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]?.thumbnailFilename).toBeNull()
    expect(issues).toEqual([
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
