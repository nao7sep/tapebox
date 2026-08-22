import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

const state = vi.hoisted(() => ({ tape: null as Tape | null, libraryDir: '' }))
const upsertTape = vi.hoisted(() => vi.fn((tape: Tape) => { state.tape = tape }))
const renameTapeDurably = vi.hoisted(() => vi.fn())
vi.mock('@main/store/session', () => ({
  getTape: (id: string) => state.tape?.id === id ? state.tape : undefined,
  getTapes: () => state.tape ? [state.tape] : [],
  getBoxes: () => [],
  upsertTape,
  renameTapeDurably,
  removeTapes: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: true, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({
  clearPartials: vi.fn(), downloadThumbnail: vi.fn(), probe: vi.fn(),
}))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const rollbackMutation = vi.hoisted(() => ({
  mode: null as null | 'committed-winner' | 'final-cleanup',
  durableFails: false,
  publishes: 0,
  firstClaim: null as null | { path: string; identity: string },
  cleanupPath: '',
  dir: '',
  order: [] as string[],
  sourcesVisibleAtCommit: false,
  destinationsVisibleAtCommit: false,
}))
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    publishFileNoOverwrite: vi.fn(async (...args: Parameters<typeof actual.publishFileNoOverwrite>) => {
      rollbackMutation.publishes += 1
      if (rollbackMutation.mode === 'committed-winner' && rollbackMutation.publishes === 2) {
        const winner = join(rollbackMutation.dir, 'external-winner.tmp')
        await writeFile(winner, 'external winner')
        await rename(winner, rollbackMutation.firstClaim!.path)
        throw new Error('second publication failed')
      }
      const claim = await actual.publishFileNoOverwrite(...args)
      rollbackMutation.firstClaim ??= claim
      rollbackMutation.order.push(`publish:${basename(claim.path)}`)
      return claim
    }),
    unlinkClaimedFiles: vi.fn(async (...args: Parameters<typeof actual.unlinkClaimedFiles>) => {
      rollbackMutation.order.push(state.tape?.name === 'renamed' ? 'cleanup:obsolete' : 'cleanup:rollback')
      if (rollbackMutation.mode === 'final-cleanup' && state.tape?.name === 'renamed') {
        rollbackMutation.cleanupPath = args[0][0]!.path
        throw new AggregateError(
          [new Error(`Recovery claim remains at ${rollbackMutation.cleanupPath}`)],
          'old-claim cleanup failed',
        )
      }
      return actual.unlinkClaimedFiles(...args)
    }),
  }
})

const { registerLibraryHandlers } = await import('@main/ipc/library')

let dir: string

beforeEach(async () => {
  handlers.clear()
  upsertTape.mockClear()
  renameTapeDurably.mockReset()
  dir = await mkdtemp(join(tmpdir(), 'tapebox-rename-'))
  state.libraryDir = dir
  rollbackMutation.mode = null
  rollbackMutation.durableFails = false
  rollbackMutation.publishes = 0
  rollbackMutation.firstClaim = null
  rollbackMutation.cleanupPath = ''
  rollbackMutation.dir = dir
  rollbackMutation.order = []
  rollbackMutation.sourcesVisibleAtCommit = false
  rollbackMutation.destinationsVisibleAtCommit = false
  state.tape = {
    id: 'Abc123_-xy', sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg',
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, archivedAtUtc: null, boxId: null, order: 0,
    pausedAtUtc: null, failedAtUtc: null, lastError: null,
  }
  await writeFile(join(dir, 'Take.mp4'), 'video')
  await writeFile(join(dir, 'Take.jpg'), 'poster')
  await writeFile(join(dir, 'Take.json'), JSON.stringify({
    tapebox: {
      sourceUrl: state.tape.sourceUrl, name: 'Take', addedAtUtc: state.tape.addedAtUtc,
      downloadedAtUtc: state.tape.downloadedAtUtc, renamedAtUtc: null, media: null,
      mediaFilename: 'Take.mp4', thumbnailFilename: 'Take.jpg',
    },
  }))
  renameTapeDurably.mockImplementation(async (tape: Tape) => {
    rollbackMutation.order.push('catalog:start')
    rollbackMutation.sourcesVisibleAtCommit = await Promise.all(
      ['Take.mp4', 'Take.json', 'Take.jpg'].map((name) => readFile(join(dir, name)).then(() => true, () => false)),
    ).then((visible) => visible.every(Boolean))
    rollbackMutation.destinationsVisibleAtCommit = await Promise.all(
      ['renamed.mp4', 'renamed.json', 'renamed.jpg'].map((name) => readFile(join(dir, name)).then(() => true, () => false)),
    ).then((visible) => visible.every(Boolean))
    if (rollbackMutation.durableFails) throw new Error('catalog disk full')
    state.tape = tape
    rollbackMutation.order.push('catalog:committed')
  })
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('library:rename', () => {
  it('keeps physical filenames authoritative during a case-only logical rename', async () => {
    const rename = handlers.get('library:rename')
    if (!rename) throw new Error('library:rename was not registered')

    await rename({ tapeId: state.tape!.id, name: 'take' })

    expect((await readdir(dir)).sort()).toEqual(['Take.jpg', 'Take.json', 'Take.mp4'])
    expect(await readFile(join(dir, 'Take.mp4'), 'utf8')).toBe('video')
    expect(await readFile(join(dir, 'Take.jpg'), 'utf8')).toBe('poster')
    expect(state.tape).toMatchObject({ name: 'take', filename: 'Take.mp4', sidecarFilename: 'Take.json' })
    const sidecar = JSON.parse(await readFile(join(dir, 'Take.json'), 'utf8')) as { tapebox: Record<string, unknown> }
    expect(sidecar.tapebox).toMatchObject({ name: 'take', mediaFilename: 'Take.mp4', thumbnailFilename: 'Take.jpg' })
    expect(rollbackMutation.publishes).toBe(0)
  })

  it('preserves every bundle member during a composed/decomposed rename', async () => {
    const decomposed = 'Cafe\u0301'
    const composed = 'Caf\u00e9'
    for (const extension of ['mp4', 'json', 'jpg']) {
      await rename(join(dir, `Take.${extension}`), join(dir, `${decomposed}.${extension}`))
    }
    state.tape = {
      ...state.tape!,
      name: decomposed,
      filename: `${decomposed}.mp4`,
      sidecarFilename: `${decomposed}.json`,
      thumbnailFilename: `${decomposed}.jpg`,
    }
    const invoke = handlers.get('library:rename')!

    await invoke({ tapeId: state.tape.id, name: composed })

    expect((await readdir(dir)).sort()).toEqual([`${decomposed}.jpg`, `${decomposed}.json`, `${decomposed}.mp4`])
    expect(await readFile(join(dir, `${decomposed}.mp4`), 'utf8')).toBe('video')
    expect(state.tape).toMatchObject({
      name: composed,
      filename: `${decomposed}.mp4`,
      sidecarFilename: `${decomposed}.json`,
    })
    expect(rollbackMutation.publishes).toBe(0)
  })

  it('preserves a replacement winner instead of deleting it during committed-member rollback', async () => {
    rollbackMutation.mode = 'committed-winner'
    const invoke = handlers.get('library:rename')!

    await expect(invoke({ tapeId: state.tape!.id, name: 'renamed' })).rejects.toThrow(/publication failed/)

    expect(await readFile(join(dir, 'renamed.mp4'), 'utf8')).toBe('external winner')
    expect(await readFile(join(dir, 'Take.mp4'), 'utf8')).toBe('video')
  })

  it('publishes all destinations while every old source is still visible, then commits before cleanup', async () => {
    const invoke = handlers.get('library:rename')!

    await invoke({ tapeId: state.tape!.id, name: 'renamed' })

    expect(rollbackMutation.sourcesVisibleAtCommit).toBe(true)
    expect(rollbackMutation.destinationsVisibleAtCommit).toBe(true)
    expect(rollbackMutation.order.slice(0, 3)).toEqual([
      'publish:renamed.mp4', 'publish:renamed.json', 'publish:renamed.jpg',
    ])
    expect(rollbackMutation.order.indexOf('catalog:committed')).toBeLessThan(
      rollbackMutation.order.indexOf('cleanup:obsolete'),
    )
    expect((await readdir(dir)).sort()).toEqual(['renamed.jpg', 'renamed.json', 'renamed.mp4'])
  })

  it('rolls back every destination and keeps the old catalog/sources when durable commit fails', async () => {
    rollbackMutation.durableFails = true
    const invoke = handlers.get('library:rename')!

    await expect(invoke({ tapeId: state.tape!.id, name: 'renamed' })).rejects.toThrow(/catalog disk full/)

    expect(rollbackMutation.sourcesVisibleAtCommit).toBe(true)
    expect(rollbackMutation.destinationsVisibleAtCommit).toBe(true)
    expect(await readFile(join(dir, 'Take.mp4'), 'utf8')).toBe('video')
    expect(await readFile(join(dir, 'Take.jpg'), 'utf8')).toBe('poster')
    expect(state.tape?.name).toBe('Take')
    await expect(readFile(join(dir, 'renamed.mp4'))).rejects.toThrow()
    await expect(readFile(join(dir, 'renamed.json'))).rejects.toThrow()
    await expect(readFile(join(dir, 'renamed.jpg'))).rejects.toThrow()
    expect(rollbackMutation.order.at(-1)).toBe('cleanup:rollback')
  })

  it('keeps the committed catalog authoritative when final old-claim cleanup fails', async () => {
    rollbackMutation.mode = 'final-cleanup'
    const invoke = handlers.get('library:rename')!

    const failure = Promise.resolve(invoke({ tapeId: state.tape!.id, name: 'renamed' }))
    await expect(failure).rejects.toThrow(/Rename committed and the catalog points to the new bundle/)
    expect(rollbackMutation.cleanupPath).toBe(join(dir, 'Take.mp4'))
    await expect(failure).rejects.toThrow(rollbackMutation.cleanupPath)

    expect(state.tape).toMatchObject({
      name: 'renamed',
      filename: 'renamed.mp4',
      sidecarFilename: 'renamed.json',
      thumbnailFilename: 'renamed.jpg',
    })
    expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining([
      'Take.jpg', 'Take.json', 'Take.mp4', 'renamed.jpg', 'renamed.json', 'renamed.mp4',
    ]))
  })
})
