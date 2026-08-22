import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
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

const state = vi.hoisted(() => ({ tape: null as Tape | null, libraryDir: '' }))
const upsertTape = vi.hoisted(() => vi.fn((tape: Tape) => { state.tape = tape }))
vi.mock('@main/store/session', () => ({
  getTape: (id: string) => state.tape?.id === id ? state.tape : undefined,
  getTapes: () => state.tape ? [state.tape] : [],
  getBoxes: () => [],
  upsertTape,
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
  mode: null as null | 'committed-winner' | 'held-winner' | 'source-winner' | 'restore-failure',
  publishes: 0,
  moves: 0,
  firstClaim: null as null | { path: string; identity: string },
  dir: '',
}))
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    moveClaimedFile: vi.fn(async (...args: Parameters<typeof actual.moveClaimedFile>) => {
      rollbackMutation.moves += 1
      if (rollbackMutation.mode === 'source-winner' && rollbackMutation.moves === 1) {
        const winner = join(rollbackMutation.dir, 'external-source-winner.tmp')
        await writeFile(winner, 'external source winner')
        await rename(winner, args[0].path)
      }
      return actual.moveClaimedFile(...args)
    }),
    publishFileNoOverwrite: vi.fn(async (...args: Parameters<typeof actual.publishFileNoOverwrite>) => {
      rollbackMutation.publishes += 1
      if (rollbackMutation.mode === 'committed-winner' && rollbackMutation.publishes === 2) {
        const winner = join(rollbackMutation.dir, 'external-winner.tmp')
        await writeFile(winner, 'external winner')
        await rename(winner, rollbackMutation.firstClaim!.path)
        throw new Error('second publication failed')
      }
      if (rollbackMutation.mode === 'held-winner' && rollbackMutation.publishes === 1) {
        const heldNames = (await readdir(rollbackMutation.dir)).filter((name) => name.endsWith('.tmp.original'))
        let held: string | undefined
        for (const candidate of heldNames) {
          if ((await readFile(join(rollbackMutation.dir, candidate), 'utf8')) === 'video') held = candidate
        }
        if (!held) throw new Error('held fixture not found')
        const winner = join(rollbackMutation.dir, 'external-hold-winner.tmp')
        await writeFile(winner, 'external hold winner')
        await rename(winner, join(rollbackMutation.dir, held))
        throw new Error('publication failed after hold replacement')
      }
      if (rollbackMutation.mode === 'restore-failure' && rollbackMutation.publishes === 1) {
        throw new Error('publication failed before restoration')
      }
      const claim = await actual.publishFileNoOverwrite(...args)
      rollbackMutation.firstClaim ??= claim
      return claim
    }),
    restoreClaimedFile: vi.fn(async (...args: Parameters<typeof actual.restoreClaimedFile>) => {
      if (rollbackMutation.mode === 'restore-failure') return null
      return actual.restoreClaimedFile(...args)
    }),
  }
})

const { registerLibraryHandlers } = await import('@main/ipc/library')

let dir: string

beforeEach(async () => {
  handlers.clear()
  upsertTape.mockClear()
  dir = await mkdtemp(join(tmpdir(), 'tapebox-rename-'))
  state.libraryDir = dir
  rollbackMutation.mode = null
  rollbackMutation.publishes = 0
  rollbackMutation.moves = 0
  rollbackMutation.firstClaim = null
  rollbackMutation.dir = dir
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
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('library:rename', () => {
  it('preserves every bundle member during a case-only rename', async () => {
    const rename = handlers.get('library:rename')
    if (!rename) throw new Error('library:rename was not registered')

    await rename({ tapeId: state.tape!.id, name: 'take' })

    expect((await readdir(dir)).sort()).toEqual(['take.jpg', 'take.json', 'take.mp4'])
    expect(await readFile(join(dir, 'take.mp4'), 'utf8')).toBe('video')
    expect(await readFile(join(dir, 'take.jpg'), 'utf8')).toBe('poster')
    expect(state.tape).toMatchObject({ name: 'take', filename: 'take.mp4', sidecarFilename: 'take.json' })
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

    expect((await readdir(dir)).sort()).toEqual([`${composed}.jpg`, `${composed}.json`, `${composed}.mp4`])
    expect(await readFile(join(dir, `${composed}.mp4`), 'utf8')).toBe('video')
    expect(state.tape).toMatchObject({
      name: composed,
      filename: `${composed}.mp4`,
      sidecarFilename: `${composed}.json`,
    })
  })

  it('preserves a replacement winner instead of deleting it during committed-member rollback', async () => {
    rollbackMutation.mode = 'committed-winner'
    const invoke = handlers.get('library:rename')!

    await expect(invoke({ tapeId: state.tape!.id, name: 'renamed' })).rejects.toThrow(/publication failed/)

    expect(await readFile(join(dir, 'renamed.mp4'), 'utf8')).toBe('external winner')
    expect(await readFile(join(dir, 'Take.mp4'), 'utf8')).toBe('video')
  })

  it('does not restore or delete a held-original pathname replaced by an external winner', async () => {
    rollbackMutation.mode = 'held-winner'
    const invoke = handlers.get('library:rename')!

    await expect(invoke({ tapeId: state.tape!.id, name: 'take' })).rejects.toThrow(/hold replacement/)

    const heldNames = (await readdir(dir)).filter((name) => name.endsWith('.tmp.original'))
    let held: string | undefined
    for (const candidate of heldNames) {
      if ((await readFile(join(dir, candidate), 'utf8')) === 'external hold winner') held = candidate
    }
    expect(held).toBeDefined()
    expect(await readFile(join(dir, held!), 'utf8')).toBe('external hold winner')
    expect(await readFile(join(dir, 'Take.jpg'), 'utf8')).toBe('poster')
  })

  it('restores a source winner that arrives at the exact case-only hold boundary', async () => {
    rollbackMutation.mode = 'source-winner'
    const invoke = handlers.get('library:rename')!

    await expect(invoke({ tapeId: state.tape!.id, name: 'take' })).rejects.toThrow(/changed while being held/)

    expect(await readFile(join(dir, 'Take.mp4'), 'utf8')).toBe('external source winner')
    expect(await readFile(join(dir, 'Take.jpg'), 'utf8')).toBe('poster')
    expect(state.tape?.name).toBe('Take')
  })

  it('surfaces failed restoration and the recoverable hold paths', async () => {
    rollbackMutation.mode = 'restore-failure'
    const invoke = handlers.get('library:rename')!

    const failure = invoke({ tapeId: state.tape!.id, name: 'take' })
    await expect(failure).rejects.toThrow(/publication failed before restoration/)
    await expect(failure).rejects.toThrow(/Recovery claims: .*\.tmp\.original/)

    const heldNames = (await readdir(dir)).filter((name) => name.endsWith('.tmp.original'))
    expect(heldNames.length).toBe(3)
    const heldContents = await Promise.all(heldNames.map((name) => readFile(join(dir, name), 'utf8')))
    expect(heldContents).toContain('video')
  })
})
