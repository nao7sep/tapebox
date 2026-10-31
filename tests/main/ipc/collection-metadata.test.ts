import { collectionSourceIndex } from '@shared/source-identity'
import type { SourceRef } from '@shared/source-identity'
vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as fileIo from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { tapeDir } from '@main/paths'
import { cancelAllWork, hasRunningWork, resumeWork } from '@main/work-registry'
import { until } from '../../helpers/until'

// Re-probing a tape and accepting the result. The tape's fields and the
// sidecar's description are written for real; only the network-facing services
// (yt-dlp's probe and thumbnail fetch, ffmpeg's image gate) are substituted.
const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))

const state = vi.hoisted(() => ({ collectionDir: '', tapes: [] as Tape[] }))
const emit = vi.hoisted(() => vi.fn())
const probe = vi.hoisted(() => vi.fn())
const downloadThumbnail = vi.hoisted(() => vi.fn())
const saveThumbnailJpeg = vi.hoisted(() => vi.fn())
const persistNow = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('@main/store/session', () => ({
  sourceOwner: (ref: SourceRef, exceptId?: string) => collectionSourceIndex(state.tapes, exceptId).find(ref),
  persistNow,
  onCollectionSaveFailure: () => {},
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
  getCollectionDir: () => state.collectionDir,
  getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn(), holdFromScheduling: () => () => {} }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail, probe }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename) }
})

const { registerCollectionHandlers } = await import('@main/ipc/collection')

/** A file in a tape's folder, which this creates. */
function at(id: string, name: string): string {
  mkdirSync(folder(id), { recursive: true })
  return join(folder(id), name)
}

/** An Inbox tape's own folder. */
function folder(id: string): string {
  return tapeDir(state.collectionDir, { id, shelved: false })
}

// Each tape has its folder in the collection, as a downloaded tape does.
function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  mkdirSync(folder(overrides.id), { recursive: true })
  return {
    sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', addedIndex: 0, sourceId: 'source', extractor: 'test',
    title: 'Old title', uploader: 'Old uploader', durationSeconds: 61, chapterCount: 3,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, shelved: false,
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  }
}

function invoke<T>(channel: string, req?: unknown): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} was not registered`)
  return Promise.resolve(handler(req) as T)
}

const PROBED_AT = '2026-02-03T04:05:06.789Z'
const ACCEPTED = { title: 'New title', uploader: 'New uploader', description: 'New description', probedAtUtc: PROBED_AT }

beforeEach(async () => {
  handlers.clear()
  vi.clearAllMocks()
  vi.mocked(fileIo.open).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open)
  vi.mocked(fileIo.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename)
  persistNow.mockReset().mockResolvedValue(true)
  state.collectionDir = await mkdtemp(join(tmpdir(), 'tapebox-collection-metadata-'))
  state.tapes = []
  registerCollectionHandlers()
})

afterEach(async () => {
  // A test that quits closes the work registry; reopen it for the next one.
  resumeWork()
  vi.restoreAllMocks()
  await rm(state.collectionDir, { recursive: true, force: true })
})

describe('re-probing a tape', () => {
  it('cancels only the named probe and retains ownership through physical settlement', async () => {
    state.tapes = [makeTape({ id: 'Reprobethi' })]
    const signals: AbortSignal[] = []
    const finishes: Array<() => void> = []
    probe.mockImplementation((_id, _url, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise((resolve) => finishes.push(() => resolve({ kind: 'video', title: null, uploader: null, description: null })))
    })
    const first = invoke('collection:probeMetadata', { tapeId: 'Reprobethi', requestId: 'closed-editor' })
    const second = invoke('collection:probeMetadata', { tapeId: 'Reprobethi', requestId: 'reopened-editor' })
    await invoke('collection:cancelMetadataProbe', { requestId: 'closed-editor' })
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(hasRunningWork()).toBe(true)
    finishes[1]!()
    await second
    expect(hasRunningWork()).toBe(true)
    finishes[0]!()
    await first
    expect(hasRunningWork()).toBe(false)
    await invoke('collection:cancelMetadataProbe', { requestId: 'closed-editor' })
    expect(signals[1]!.aborted).toBe(false)
  })

  it('reports what the source says now, writing nothing', async () => {
    const tape = makeTape({ id: 'Reprobethi' })
    state.tapes = [tape]
    probe.mockResolvedValue({ kind: 'video', title: 'Fresh', uploader: 'Channel', description: 'Fresh notes', sourceId: 'x' })

    await expect(invoke('collection:probeMetadata', { tapeId: 'Reprobethi', requestId: 'probe-test' })).resolves.toEqual({
      title: 'Fresh',
      uploader: 'Channel',
      description: 'Fresh notes',
      probedAtUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith('Reprobethi', tape.sourceUrl, expect.anything())
    expect(state.tapes[0], 'the tape is untouched until the user accepts').toBe(tape)
    expect(emit).not.toHaveBeenCalled()
  })

  it('refuses when the link now points at a list of videos', async () => {
    state.tapes = [makeTape({ id: 'Nowaplayli' })]
    probe.mockResolvedValue({ kind: 'page', entries: [] })

    await expect(invoke('collection:probeMetadata', { tapeId: 'Nowaplayli', requestId: 'probe-test' })).rejects.toThrow(
      'This link now points to a list of videos, not a single video.',
    )
  })

  it('refuses for a tape the collection does not hold', async () => {
    await expect(invoke('collection:probeMetadata', { tapeId: 'not-a-tape', requestId: 'probe-test' })).rejects.toThrow(
      'The operation could not be completed.',
    )
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('accepting refreshed metadata', () => {
  it('waits for the collection save before reporting success', async () => {
    state.tapes = [makeTape({ id: 'Savewait01', filename: null })]
    let release!: (value: boolean) => void
    persistNow.mockImplementation(() => new Promise<boolean>((resolve) => { release = resolve }))
    const apply = invoke<Tape>('collection:applyMetadata', { tapeId: 'Savewait01', metadata: ACCEPTED })
    let settled = false
    void apply.then(() => { settled = true }, () => { settled = true })
    try {
      await until(() => expect(persistNow).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      expect(state.tapes[0]?.title).toBe('New title')
    } finally { release(true); await apply }
  })

  it.each(['false', 'rejected'])('reports a truthful partial result on a %s collection save without rolling back saved sidecar or live metadata', async (kind) => {
    const sidecar = at('Partial001', 'Take.json')
    await writeFile(sidecar, JSON.stringify({ formatVersion: 1, title: 'Old title' }))
    state.tapes = [makeTape({ id: 'Partial001', sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg' })]
    if (kind === 'false') persistNow.mockResolvedValueOnce(false)
    else persistNow.mockRejectedValueOnce(new Error('collection writer rejected'))
    await expect(invoke('collection:applyMetadata', { tapeId: 'Partial001', metadata: ACCEPTED })).rejects.toMatchObject({ userMessage: { key: 'refresh.applyPartial' } })
    expect(state.tapes[0]?.title).toBe('New title')
    expect(JSON.parse(await readFile(sidecar, 'utf8')).title).toBe('New title')
    expect(emit).toHaveBeenCalledWith('tapes:updated', expect.objectContaining({ title: 'New title' }))
  })

  it('preserves unrelated box and order changes made during Apply', async () => {
    const tape = makeTape({ id: 'Busy001aaa' })
    state.tapes = [tape]
    let release!: (value: string | null) => void
    downloadThumbnail.mockImplementationOnce(() => new Promise<string | null>((resolve) => { release = resolve }))
    const apply = invoke<Tape>('collection:applyMetadata', { tapeId: tape.id, metadata: ACCEPTED })
    try {
      await until(() => expect(downloadThumbnail).toHaveBeenCalledOnce())
      state.tapes = [{ ...tape, boxId: 'box-summer', order: 7 }]
    } finally { release(null); await apply }
    expect(state.tapes[0]).toMatchObject({ title: 'New title', boxId: 'box-summer', order: 7 })
    await expect(invoke('collection:applyMetadata', { tapeId: tape.id, metadata: ACCEPTED })).resolves.toMatchObject({ title: 'New title' })
  })

  it('saves the tape\'s fields and puts the same values in the sidecar', async () => {
    const sidecar = at('Acceptthis', 'Take.json')
    await writeFile(sidecar, JSON.stringify({ formatVersion: 1, id: 'source', description: 'Old description', extra: 'kept' }), 'utf8')
    state.tapes = [makeTape({ id: 'Acceptthis', sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg' })]

    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Acceptthis', metadata: ACCEPTED })

    expect(updated).toMatchObject({ title: 'New title', uploader: 'New uploader', thumbnailFilename: 'Take.jpg' })
    expect(updated.probedAtUtc, 'the probe time is when the source answered, not the Apply click').toBe(PROBED_AT)
    expect(updated, 'facts fixed by the file are not re-stated').toMatchObject({ durationSeconds: 61, chapterCount: 3 })
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toEqual({
      formatVersion: 1,
      id: 'source',
      title: 'New title',
      uploader: 'New uploader',
      description: 'New description',
      extra: 'kept',
    })
    expect(state.tapes[0]).toEqual(updated)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:updated', updated)
    expect(downloadThumbnail, 'a tape that already has a poster is left alone').not.toHaveBeenCalled()
  })

  it('leaves a sidecar that already holds the accepted values unwritten', async () => {
    const sidecar = at('Unchanged1', 'Take.json')
    const text = JSON.stringify({ formatVersion: 1, title: 'New title', uploader: 'New uploader', description: 'New description' })
    await writeFile(sidecar, text, 'utf8')
    const before = (await stat(sidecar)).mtimeMs
    state.tapes = [makeTape({ id: 'Unchanged1', sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg' })]

    await invoke<Tape>('collection:applyMetadata', { tapeId: 'Unchanged1', metadata: ACCEPTED })

    expect(await readFile(sidecar, 'utf8')).toBe(text)
    expect((await stat(sidecar)).mtimeMs).toBe(before)
  })

  it('applies nothing when the sidecar cannot be written', async () => {
    const tape = makeTape({ id: 'Nosidecarf', sidecarFilename: 'gone.json', thumbnailFilename: 'Take.jpg' })
    state.tapes = [tape]

    await expect(invoke<Tape>('collection:applyMetadata', { tapeId: 'Nosidecarf', metadata: ACCEPTED })).rejects.toThrow()

    expect(state.tapes[0], 'the tape and the sidecar never disagree').toBe(tape)
    expect(emit).not.toHaveBeenCalled()
  })

  it('refuses a sidecar in a newer format, naming it, and leaves it byte-identical', async () => {
    const sidecar = at('Newersidec', 'Take.json')
    const text = JSON.stringify({ formatVersion: 2, title: 'Future', extra: 'kept' })
    await writeFile(sidecar, text, 'utf8')
    const tape = makeTape({ id: 'Newersidec', sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg' })
    state.tapes = [tape]

    const failure = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Newersidec', metadata: ACCEPTED })
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ userMessage: { key: 'errors.fileNewer', values: { name: 'Take.json' } } })
    expect(await readFile(sidecar, 'utf8')).toBe(text)
    expect(state.tapes[0], 'nothing is applied').toBe(tape)
    await expect(invoke('collection:getSidecar', { tapeId: 'Newersidec' }), 'nor shown as if read')
      .rejects.toMatchObject({ userMessage: { key: 'errors.fileNewer' } })
  })

  it('backfills a poster for a downloaded tape that has none', async () => {
    state.tapes = [makeTape({ id: 'Noposteryt', filename: 'Holiday.mp4' })]
    const raw = at('Noposteryt', 'Noposteryt.poster-raw.webp')
    downloadThumbnail.mockImplementation(async () => { await writeFile(raw, 'raw poster'); return raw })
    saveThumbnailJpeg.mockResolvedValue('Holiday.jpg')

    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Noposteryt', metadata: ACCEPTED })

    expect(downloadThumbnail).toHaveBeenCalledExactlyOnceWith(
      'Noposteryt',
      'https://example.test/watch',
      folder('Noposteryt'),
      expect.anything(),
    )
    expect(saveThumbnailJpeg).toHaveBeenCalledExactlyOnceWith(
      'Noposteryt',
      raw,
      folder('Noposteryt'),
      'Holiday',
      expect.any(AbortSignal),
    )
    expect(updated.thumbnailFilename).toBe('Holiday.jpg')
    await expect(readFile(raw)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records a backfilled poster in the tape alone, leaving the sidecar\'s own section as it was', async () => {
    const sidecar = at('Posterside', 'Holiday.json')
    const tape = makeTape({ id: 'Posterside', filename: 'Holiday.mp4', sidecarFilename: 'Holiday.json' })
    await writeFile(sidecar, JSON.stringify({ formatVersion: 1, id: 'source', tapebox: { media: null } }), 'utf8')
    state.tapes = [tape]
    const raw = at('Posterside', 'Posterside.poster-raw.webp')
    downloadThumbnail.mockImplementation(async () => { await writeFile(raw, 'raw poster'); return raw })
    saveThumbnailJpeg.mockResolvedValue('Holiday.jpg')

    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Posterside', metadata: ACCEPTED })

    const written = JSON.parse(await readFile(sidecar, 'utf8')) as { title: string; tapebox: Record<string, unknown> }
    expect(updated.thumbnailFilename).toBe('Holiday.jpg')
    expect(written.tapebox).toEqual({ media: null })
    expect(written.title).toBe('New title')
  })

  it('fetches no poster beside a file that spells the stem differently', async () => {
    await writeFile(at('Casealias1', 'holiday.webp'), 'untracked')
    state.tapes = [makeTape({ id: 'Casealias1', filename: 'Holiday.mp4' })]

    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Casealias1', metadata: ACCEPTED })

    expect(downloadThumbnail).not.toHaveBeenCalled()
    expect(updated.thumbnailFilename).toBeNull()
  })

  it('leaves the poster empty when the source has none to give', async () => {
    state.tapes = [makeTape({ id: 'Sourcehasn', filename: 'Holiday.mp4' })]
    downloadThumbnail.mockResolvedValue(null)

    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Sourcehasn', metadata: ACCEPTED })

    expect(saveThumbnailJpeg).not.toHaveBeenCalled()
    expect(updated.thumbnailFilename).toBeNull()
  })

  it('applies the metadata anyway when the poster fetch fails', async () => {
    state.tapes = [makeTape({ id: 'Posterfail', filename: 'Holiday.mp4' })]
    downloadThumbnail.mockRejectedValue(new Error('network unreachable'))

    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Posterfail', metadata: ACCEPTED })

    expect(updated).toMatchObject({ title: 'New title', thumbnailFilename: null })
    expect(log.warn).toHaveBeenCalledWith('thumbnail backfill failed', expect.objectContaining({ tapeId: 'Posterfail' }))
  })

  it('does not go looking for a poster for a tape with no file yet', async () => {
    state.tapes = [makeTape({ id: 'Nofileyet1', filename: null })]

    await invoke('collection:applyMetadata', { tapeId: 'Nofileyet1', metadata: ACCEPTED })

    expect(downloadThumbnail).not.toHaveBeenCalled()
  })

  it('refuses for a tape the collection does not hold', async () => {
    await expect(invoke('collection:applyMetadata', { tapeId: 'not-a-tape', metadata: ACCEPTED })).rejects.toThrow(
      'The operation could not be completed.',
    )
  })

  it('owns the entire Apply until quit cancellation has joined its poster work', async () => {
    state.tapes = [makeTape({ id: 'Quitapply1' })]
    downloadThumbnail.mockImplementationOnce((_id, _url, _dir, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const apply = invoke('collection:applyMetadata', { tapeId: 'Quitapply1', metadata: ACCEPTED }).catch((error: unknown) => error)
    try { await until(() => expect(downloadThumbnail).toHaveBeenCalledOnce()) }
    finally { await cancelAllWork(); await apply }
    expect(state.tapes[0]?.title).toBe('Old title')
    expect(saveThumbnailJpeg).not.toHaveBeenCalled()
    expect(persistNow).not.toHaveBeenCalled()
  })

  it('finishes its collection commit when cancelled after the sidecar has committed', async () => {
    const sidecar = at('Lateabort1', 'Take.json')
    await writeFile(sidecar, JSON.stringify({ formatVersion: 1, id: 'source' }), 'utf8')
    state.tapes = [makeTape({ id: 'Lateabort1', sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg' })]
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let quitting: Promise<void> | undefined
    // The quit arrives right after the sidecar's rename commits it.
    vi.mocked(fileIo.rename).mockImplementation(async (from, to) => {
      await original.rename(from, to)
      if (String(to) === sidecar && !quitting) quitting = cancelAllWork()
    })
    const updated = await invoke<Tape>('collection:applyMetadata', { tapeId: 'Lateabort1', metadata: ACCEPTED })
    expect(quitting, 'the quit arrived after the sidecar committed').toBeDefined()
    await quitting
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toMatchObject({ title: 'New title' })
    expect(persistNow).toHaveBeenCalledOnce()
    expect(updated).toMatchObject({ title: 'New title', uploader: 'New uploader' })
    expect(state.tapes[0]).toEqual(updated)
  })
})
