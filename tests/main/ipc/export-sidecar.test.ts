import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

// The exported bundle's sidecar records the name it leaves under, and when that
// name differs from the one it had, the rename that export made.
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
  pausedAtUtc: null, failedAtUtc: null, lastError: null,
}
const libraryState = vi.hoisted(() => ({ dir: '' }))
vi.mock('@main/store/session', () => ({ getTape: () => tape }))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => libraryState.dir }))
vi.mock('@main/ipc/library', () => ({
  caseInsensitiveSiblingExists: vi.fn(async () => false),
  removeTapes: vi.fn(async () => ({ failed: [] })),
}))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { registerExportHandlers } = await import('@main/ipc/export')

let root: string
let destinationDir: string

beforeEach(async () => {
  handlers.clear()
  root = await mkdtemp(join(tmpdir(), 'tapebox-export-sidecar-'))
  libraryState.dir = join(root, 'library')
  destinationDir = join(root, 'destination')
  await mkdir(libraryState.dir)
  await mkdir(destinationDir)
  await writeFile(join(libraryState.dir, 'Take.mp4'), 'video')
  await writeFile(join(libraryState.dir, 'Take.json'), JSON.stringify({
    tapebox: {
      sourceUrl: tape.sourceUrl, name: 'Take', addedAtUtc: tape.addedAtUtc,
      downloadedAtUtc: tape.downloadedAtUtc, renamedAtUtc: RENAMED_AT, media: null,
      mediaFilename: 'Take.mp4', thumbnailFilename: null,
    },
  }))
  registerExportHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function exportedSidecar(name: string): Promise<Record<string, unknown>> {
  await handlers.get('export:files')!({ tapeId: tape.id, destinationDir, name, deleteFromApp: false })
  const sidecar = JSON.parse(await readFile(join(destinationDir, `${name}.json`), 'utf8')) as { tapebox: Record<string, unknown> }
  return sidecar.tapebox
}

describe('export:files sidecar', () => {
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
