vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

// The library sidecar holds yt-dlp's info and the media facts; the exported
// bundle's sidecar carries the catalog's record of the tape under the name it
// leaves under, and when that name differs from the one it had, the rename that
// export made, so the bundle can be imported from its sidecar alone.
const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
}))

const RENAMED_AT = '2026-01-02T00:00:00.000Z'
const tape: Tape = {
  id: 'Exportside', sourceUrl: 'https://example.test/watch', state: 'downloaded',
  addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
  title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
  probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
  sidecarFilename: 'Take.json', thumbnailFilename: null,
  downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
  name: 'Take', renamedAtUtc: RENAMED_AT, archivedAtUtc: null, boxId: null, order: 0,
  pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
}
const libraryState = vi.hoisted(() => ({ dir: '' }))
const MEDIA = { width: 640, height: 360, fps: 30, vcodec: 'h264', acodec: 'aac', durationSeconds: 1, bitrateKbps: 900 }
const tapeFolder = () => join(libraryState.dir, tape.id)
vi.mock('@main/store/session', () => ({ getTape: () => tape }))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => libraryState.dir }))
vi.mock('@main/ipc/library', () => ({
  caseInsensitiveSiblingExists: vi.fn(async () => false),
  removeTapesFrom: vi.fn(async () => ({ removed: [], failed: [] as string[] })),
}))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { removeTapesFrom } = await import('@main/ipc/library')
const { registerExportHandlers } = await import('@main/ipc/export')
const { classifyImport, tapeFromSidecar } = await import('@main/core/import-classify')

let root: string
let destinationDir: string

beforeEach(async () => {
  handlers.clear()
  vi.mocked(removeTapesFrom).mockClear().mockResolvedValue({ removed: [], failed: [] })
  root = await mkdtemp(join(tmpdir(), 'tapebox-export-sidecar-'))
  libraryState.dir = join(root, 'library')
  destinationDir = join(root, 'destination')
  await mkdir(tapeFolder(), { recursive: true })
  await mkdir(destinationDir)
  await writeFile(join(tapeFolder(), 'Take.mp4'), 'video')
  await writeFile(join(tapeFolder(), 'Take.json'), JSON.stringify({ formatVersion: 1, id: 'source', tapebox: { media: MEDIA } }))
  registerExportHandlers()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function exportedSidecar(name: string): Promise<Record<string, unknown>> {
  await handlers.get('export:files')!({ tapeId: tape.id, destinationDir, name, deleteFromApp: false })
  const sidecar = JSON.parse(await readFile(join(destinationDir, `${name}.json`), 'utf8')) as { tapebox: Record<string, unknown> }
  return sidecar.tapebox
}

describe('export:files sidecar', () => {
  it('reports a kept original without undoing the completed export', async () => {
    vi.mocked(removeTapesFrom).mockClear().mockResolvedValue({ removed: [], failed: [tape.id] })
    await expect(handlers.get('export:files')!({ tapeId: tape.id, destinationDir, name: 'Holiday', deleteFromApp: true }))
      .rejects.toMatchObject({ code: 'conflict', userMessage: { key: 'errors.exportOriginalsKept' } })
    expect(await readFile(join(destinationDir, 'Holiday.mp4'), 'utf8')).toBe('video')
    expect(JSON.parse(await readFile(join(destinationDir, 'Holiday.json'), 'utf8')).tapebox.name).toBe('Holiday')
    expect(await readFile(join(tapeFolder(), 'Take.mp4'), 'utf8')).toBe('video')
  })

  it('writes the catalog\'s record and the library\'s media facts, so the bundle imports again', async () => {
    await handlers.get('export:files')!({ tapeId: tape.id, destinationDir, name: 'Take', deleteFromApp: false })
    const exported = JSON.parse(await readFile(join(destinationDir, 'Take.json'), 'utf8')) as Record<string, unknown>
    expect(exported['tapebox']).toEqual({
      sourceUrl: tape.sourceUrl, name: 'Take', addedAtUtc: tape.addedAtUtc, downloadedAtUtc: tape.downloadedAtUtc,
      renamedAtUtc: RENAMED_AT, media: MEDIA, mediaFilename: 'Take.mp4', thumbnailFilename: null,
    })
    expect(classifyImport(exported)).toEqual({ status: 'accept', sourceUrl: tape.sourceUrl, mediaFilename: 'Take.mp4', thumbnailFilename: null })
    expect(tapeFromSidecar(exported, {
      id: 'Reimport01', sourceUrl: tape.sourceUrl, mediaFilename: 'Take.mp4', sidecarFilename: 'Take.json',
      thumbnailFilename: null, order: 0, nowUtc: '2026-03-01T00:00:00.000Z',
    })).toMatchObject({ name: 'Take', addedAtUtc: tape.addedAtUtc, downloadedAtUtc: tape.downloadedAtUtc, renamedAtUtc: RENAMED_AT })
  })

  it('masks credentials in the catalog\'s source URL', async () => {
    const original = tape.sourceUrl
    tape.sourceUrl = 'https://login:password@example.test/watch?v=1&signature=SIGN_SENTINEL'
    try {
      const tb = await exportedSidecar('Take')
      expect(tb['sourceUrl']).toBe('https://[REDACTED]@example.test/watch?v=1&signature=[REDACTED]')
      expect(JSON.stringify(tb)).not.toMatch(/password|SIGN_SENTINEL/)
    } finally { tape.sourceUrl = original }
  })

  it('records the rename when the bundle leaves under a new name', async () => {
    const tb = await exportedSidecar('Holiday')

    expect(tb['name']).toBe('Holiday')
    expect(tb['mediaFilename']).toBe('Holiday.mp4')
    expect(tb['renamedAtUtc']).not.toBe(RENAMED_AT)
    expect(Date.parse(tb['renamedAtUtc'] as string)).toBeGreaterThan(Date.parse(RENAMED_AT))
  })

  it('keeps the rename time when the bundle leaves under its own name', async () => {
    const tb = await exportedSidecar('Take')

    expect(tb['name']).toBe('Take')
    expect(tb['renamedAtUtc']).toBe(RENAMED_AT)
  })
})


it('masks known credentials in the export copy while preserving sparse and opaque sidecar metadata', async () => {
  const sourcePath = join(tapeFolder(), 'Take.json')
  const original = JSON.stringify({
    formatVersion: 1,
    title: 'Original title',
    cookies: 'COOKIE_SENTINEL',
    http_headers: { Authorization: 'Bearer AUTH_SENTINEL', Cookie: 'HEADER_COOKIE_SENTINEL', 'X-Ordinary': 'keep this' },
    formats: [{
      url: 'https://login:password@video.example.test/media?id=42&signature=SIGN_SENTINEL&lsig=LSIG_SENTINEL&pot=POT_SENTINEL&quality=best',
      http_headers: { 'Proxy-Authorization': 'Basic PROXY_SENTINEL' },
      future_format_metadata: { codec_notes: ['a', 7, null] },
    }],
    opaque_root: { nested: ['untouched', { enabled: true }] },
    tapebox: {
      opaque_namespace: { keep: ['opaque', 123] },
    },
  })
  await writeFile(sourcePath, original)
  await handlers.get('export:files')!({ tapeId: tape.id, destinationDir, name: 'Portable', deleteFromApp: false })
  const exported = JSON.parse(await readFile(join(destinationDir, 'Portable.json'), 'utf8'))

  expect(await readFile(sourcePath, 'utf8')).toBe(original)
  expect(exported.cookies).toBe('[REDACTED]')
  expect(exported.http_headers).toEqual({ Authorization: 'Bearer [REDACTED]', Cookie: '[REDACTED]', 'X-Ordinary': 'keep this' })
  expect(exported.formats).toEqual([{
    url: 'https://[REDACTED]@video.example.test/media?id=42&signature=[REDACTED]&lsig=[REDACTED]&pot=[REDACTED]&quality=best',
    http_headers: { 'Proxy-Authorization': 'Basic [REDACTED]' },
    future_format_metadata: { codec_notes: ['a', 7, null] },
  }])
  expect(exported.opaque_root).toEqual({ nested: ['untouched', { enabled: true }] })
  expect(exported.tapebox).toMatchObject({
    sourceUrl: tape.sourceUrl, name: 'Portable', addedAtUtc: tape.addedAtUtc,
    downloadedAtUtc: tape.downloadedAtUtc, media: null,
    mediaFilename: 'Portable.mp4', thumbnailFilename: null,
    opaque_namespace: { keep: ['opaque', 123] },
  })
  expect(exported.tapebox.renamedAtUtc).toEqual(expect.any(String))
  expect(exported.title).toBe('Original title')
  expect(await readFile(join(destinationDir, 'Portable.mp4'), 'utf8')).toBe('video')
})
