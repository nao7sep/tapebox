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

const state = vi.hoisted(() => ({ libraryDir: '', calls: 0, first: null as null | { path: string; identity: string } }))
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    writeFileAtomicNoOverwriteVia: vi.fn(async (...args: Parameters<typeof actual.writeFileAtomicNoOverwriteVia>) => {
      state.calls += 1
      if (state.calls === 2) {
        const winner = join(state.libraryDir, 'external-import-winner.tmp')
        await writeFile(winner, 'external winner')
        await rename(winner, state.first!.path)
        throw new Error('sidecar publication failed')
      }
      const claim = await actual.writeFileAtomicNoOverwriteVia(...args)
      state.first = claim
      return claim
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
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

let root: string
let sourceDir: string

beforeEach(async () => {
  handlers.clear()
  state.calls = 0
  state.first = null
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
    const result = await handlers.get('library:import')!({ sidecarPaths: [join(sourceDir, 'clip.json')] }) as {
      imported: Tape[]
      rejected: { reason: string }[]
    }

    expect(result.imported).toEqual([])
    expect(result.rejected[0]?.reason).toMatch(/sidecar publication failed/)
    expect(await readFile(join(state.libraryDir, 'clip.mp4'), 'utf8')).toBe('external winner')
    expect(upsertTape).not.toHaveBeenCalled()
  })
})
