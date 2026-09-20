import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

// Re-probing a tape and accepting the result. The catalog fields and the
// sidecar's description are written for real; only the network-facing services
// (yt-dlp's probe and thumbnail fetch, ffmpeg's image gate) are substituted.
const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))

const state = vi.hoisted(() => ({ libraryDir: '', tapes: [] as Tape[] }))
const emit = vi.hoisted(() => vi.fn())
const probe = vi.hoisted(() => vi.fn())
const downloadThumbnail = vi.hoisted(() => vi.fn())
const saveThumbnailJpeg = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('@main/store/session', () => ({
  getTape: (id: string) => state.tapes.find((tape) => tape.id === id),
  getTapes: () => state.tapes,
  getBoxes: () => [],
  upsertTape: (tape: Tape) => {
    state.tapes = state.tapes.map((candidate) => (candidate.id === tape.id ? tape : candidate))
  },
  removeTapes: vi.fn(),
  reorderTapesDurably: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ clearPartials: vi.fn(), downloadThumbnail, probe }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  return {
    sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Old title', uploader: 'Old uploader', durationSeconds: 61, chapterCount: 3,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, archivedAtUtc: null,
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
    ...overrides,
  }
}

function invoke<T>(channel: string, req?: unknown): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} was not registered`)
  return Promise.resolve(handler(req) as T)
}

const ACCEPTED = { title: 'New title', uploader: 'New uploader', description: 'New description' }

beforeEach(async () => {
  handlers.clear()
  vi.clearAllMocks()
  state.libraryDir = await mkdtemp(join(tmpdir(), 'tapebox-library-metadata-'))
  state.tapes = []
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(state.libraryDir, { recursive: true, force: true })
})

describe('re-probing a tape', () => {
  it('reports what the source says now, writing nothing', async () => {
    const tape = makeTape({ id: 'Reprobethi' })
    state.tapes = [tape]
    probe.mockResolvedValue({ kind: 'video', title: 'Fresh', uploader: 'Channel', description: 'Fresh notes', sourceId: 'x' })

    await expect(invoke('library:probeMetadata', { tapeId: 'Reprobethi' })).resolves.toEqual({
      title: 'Fresh',
      uploader: 'Channel',
      description: 'Fresh notes',
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith(tape.sourceUrl, expect.anything())
    expect(state.tapes[0], 'the tape is untouched until the user accepts').toBe(tape)
    expect(emit).not.toHaveBeenCalled()
  })

  it('refuses when the link now points at a list of videos', async () => {
    state.tapes = [makeTape({ id: 'Nowaplayli' })]
    probe.mockResolvedValue({ kind: 'page', entries: [] })

    await expect(invoke('library:probeMetadata', { tapeId: 'Nowaplayli' })).rejects.toThrow(
      'The operation could not be completed.',
    )
  })

  it('refuses for a tape the catalog does not hold', async () => {
    await expect(invoke('library:probeMetadata', { tapeId: 'not-a-tape' })).rejects.toThrow(
      'The operation could not be completed.',
    )
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('accepting refreshed metadata', () => {
  it('saves the catalog fields and puts the description in the sidecar', async () => {
    const sidecar = join(state.libraryDir, 'Take.json')
    await writeFile(sidecar, JSON.stringify({ id: 'source', description: 'Old description', extra: 'kept' }), 'utf8')
    state.tapes = [makeTape({ id: 'Acceptthis', sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg' })]

    const updated = await invoke<Tape>('library:applyMetadata', { tapeId: 'Acceptthis', metadata: ACCEPTED })

    expect(updated).toMatchObject({ title: 'New title', uploader: 'New uploader', thumbnailFilename: 'Take.jpg' })
    expect(updated.probedAtUtc).not.toBe('2026-01-01T00:00:00.000Z')
    expect(updated, 'facts fixed by the file are not re-stated').toMatchObject({ durationSeconds: 61, chapterCount: 3 })
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toEqual({
      id: 'source',
      description: 'New description',
      extra: 'kept',
    })
    expect(state.tapes[0]).toEqual(updated)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:updated', updated)
    expect(downloadThumbnail, 'a tape that already has a poster is left alone').not.toHaveBeenCalled()
  })

  it('still applies what the user accepted when the sidecar cannot be written', async () => {
    state.tapes = [makeTape({ id: 'Nosidecarf', sidecarFilename: 'gone.json', thumbnailFilename: 'Take.jpg' })]

    const updated = await invoke<Tape>('library:applyMetadata', { tapeId: 'Nosidecarf', metadata: ACCEPTED })

    expect(updated.title).toBe('New title')
    expect(log.warn).toHaveBeenCalledWith(
      'applyMetadata: description write failed',
      expect.objectContaining({ tapeId: 'Nosidecarf' }),
    )
  })

  it('backfills a poster for a downloaded tape that has none', async () => {
    state.tapes = [makeTape({ id: 'Noposteryt', filename: 'Holiday.mp4' })]
    downloadThumbnail.mockResolvedValue(join(state.libraryDir, 'Holiday.webp'))
    saveThumbnailJpeg.mockResolvedValue('Holiday.jpg')

    const updated = await invoke<Tape>('library:applyMetadata', { tapeId: 'Noposteryt', metadata: ACCEPTED })

    expect(downloadThumbnail).toHaveBeenCalledExactlyOnceWith(
      'https://example.test/watch',
      state.libraryDir,
      'Holiday',
      expect.anything(),
    )
    expect(saveThumbnailJpeg).toHaveBeenCalledExactlyOnceWith(
      join(state.libraryDir, 'Holiday.webp'),
      state.libraryDir,
      'Holiday',
    )
    expect(updated.thumbnailFilename).toBe('Holiday.jpg')
  })

  it('leaves the poster empty when the source has none to give', async () => {
    state.tapes = [makeTape({ id: 'Sourcehasn', filename: 'Holiday.mp4' })]
    downloadThumbnail.mockResolvedValue(null)

    const updated = await invoke<Tape>('library:applyMetadata', { tapeId: 'Sourcehasn', metadata: ACCEPTED })

    expect(saveThumbnailJpeg).not.toHaveBeenCalled()
    expect(updated.thumbnailFilename).toBeNull()
  })

  it('applies the metadata anyway when the poster fetch fails', async () => {
    state.tapes = [makeTape({ id: 'Posterfail', filename: 'Holiday.mp4' })]
    downloadThumbnail.mockRejectedValue(new Error('network unreachable'))

    const updated = await invoke<Tape>('library:applyMetadata', { tapeId: 'Posterfail', metadata: ACCEPTED })

    expect(updated).toMatchObject({ title: 'New title', thumbnailFilename: null })
    expect(log.warn).toHaveBeenCalledWith('thumbnail backfill failed', expect.objectContaining({ tapeId: 'Posterfail' }))
  })

  it('does not go looking for a poster for a tape with no file yet', async () => {
    state.tapes = [makeTape({ id: 'Nofileyet1', filename: null })]

    await invoke('library:applyMetadata', { tapeId: 'Nofileyet1', metadata: ACCEPTED })

    expect(downloadThumbnail).not.toHaveBeenCalled()
  })

  it('refuses for a tape the catalog does not hold', async () => {
    await expect(invoke('library:applyMetadata', { tapeId: 'not-a-tape', metadata: ACCEPTED })).rejects.toThrow(
      'The operation could not be completed.',
    )
  })
})
