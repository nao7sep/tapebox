vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSchema, type Tape } from '@shared/domain'
import type { ImportResult } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  libraryDir: '', catalog: '', heldCopy: '', heldCatalog: '',
  held: () => {}, release: null as Promise<void> | null,
}))
const handlers = new Map<string, (req: unknown) => Promise<unknown>>()
const emit = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req) as IpcReply<unknown>))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))
vi.mock('@main/paths', () => ({ paths: { get legacyCatalog() { return state.catalog + '.legacy' } }, collectionCatalog: () => state.catalog }))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }),
}))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn(), holdFromScheduling: () => () => {} }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    copyFileNoOverwrite: async (...args: Parameters<typeof actual.copyFileNoOverwrite>) => {
      await actual.copyFileNoOverwrite(...args)
      if (args[1] === state.heldCopy) { state.held(); await state.release }
    },
  }
})
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      if (args[0] === state.heldCatalog) {
        state.heldCatalog = ''
        state.held()
        await state.release
      }
      return actual.writeManagedJsonBytes(...args)
    },
  }
})

import { registerLibraryHandlers } from '@main/ipc/library'
import * as session from '@main/store/session'

let root: string
let sourceDir: string

function hold(kind: 'heldCopy' | 'heldCatalog', path: string): { started: Promise<void>; release: () => void } {
  let started!: () => void
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  state[kind] = path
  state.held = started
  state.release = waiting
  return { started: ready, release }
}

async function stageBundle(dir: string, stem: string, sourceUrl: string, poster = false): Promise<string> {
  await writeFile(join(dir, `${stem}.mp4`), `media:${stem}`)
  if (poster) await writeFile(join(dir, `${stem}.jpg`), `poster:${stem}`)
  const path = join(dir, `${stem}.json`)
  await writeFile(path, JSON.stringify({
    formatVersion: 1,
    tapebox: {
      sourceUrl, name: stem, addedAtUtc: '2026-01-01T00:00:00.000Z',
      downloadedAtUtc: '2026-01-01T00:00:00.000Z', renamedAtUtc: null,
      media: null, mediaFilename: `${stem}.mp4`, thumbnailFilename: poster ? `${stem}.jpg` : null,
    },
  }))
  return path
}

async function importBundle(path: string): Promise<ImportResult> {
  return await handlers.get('library:import')!({ paths: [path] }) as ImportResult
}

async function savedTapes(): Promise<Tape[]> {
  const saved = JSON.parse(await readFile(state.catalog, 'utf8')) as unknown
  return SessionSchema.parse(saved).tapes
}

beforeEach(async () => {
  handlers.clear()
  root = await mkdtemp(join(tmpdir(), 'tapebox-import-concurrency-'))
  sourceDir = join(root, 'source')
  state.libraryDir = join(root, 'library')
  state.catalog = join(root, 'catalog.json')
  state.heldCopy = ''
  state.heldCatalog = ''
  state.release = null
  emit.mockClear()
  await mkdir(sourceDir)
  await mkdir(state.libraryDir)
  await session.loadSession()
  registerLibraryHandlers()
})

afterEach(async () => {
  await session.persistNow({ quitting: true })
  await rm(root, { recursive: true, force: true })
})

describe('bundle import beside catalog changes', () => {
  it('publishes a batch in selection order ahead of URLs added during its copy waits', async () => {
    const firstPath = await stageBundle(sourceDir, 'first', 'https://example.test/first')
    const secondPath = await stageBundle(sourceDir, 'second', 'https://example.test/second')
    const gate = hold('heldCopy', join(state.libraryDir, 'second.mp4'))
    const batch = handlers.get('library:import')!({ paths: [firstPath, secondPath] })
    const added = 'url0000001'
    try {
      await gate.started
      // The first batch row has been admitted while the second is still copying.
      const [first] = session.getTapes()
      expect(first?.name).toBe('first')
      // A URL added meanwhile goes on top of the inbox.
      session.upsertTape({ ...first!, id: added, sourceUrl: 'https://example.test/added', state: 'queued', name: 'concurrent',
        filename: null, sidecarFilename: null, thumbnailFilename: null, order: first!.order - 1 })
    } finally { gate.release() }
    const result = await batch as ImportResult
    expect(result.imported.map((tape) => tape.name)).toEqual(['first', 'second'])
    const inbox = session.getTapes().filter((tape) => !tape.archivedAtUtc).sort((a, b) => a.order - b.order)
    expect(inbox.map((tape) => tape.name)).toEqual(['first', 'second', 'concurrent'])
    expect(new Set(inbox.map((tape) => tape.order)).size).toBe(inbox.length)
    expect(inbox.at(-1)?.id).toBe(added)
    const batchAnnouncement = emit.mock.calls.filter(([channel]) => channel === 'tapes:added').at(-1)![1] as Tape[]
    expect(batchAnnouncement).toEqual(inbox.slice(0, 2))
    expect(await savedTapes()).toEqual(session.getTapes())
  })

  it('announces the current rows after organization changes during the catalog save', async () => {
    const path = await stageBundle(sourceDir, 'pending', 'https://example.test/pending')
    const gate = hold('heldCatalog', state.catalog)
    const importing = importBundle(path)
    try {
      await gate.started
      const listed = session.getTapes()
      expect(listed).toHaveLength(1)
      session.upsertTape({ ...listed[0]!, archivedAtUtc: '2026-01-02T00:00:00.000Z', order: -12 })
    } finally { gate.release() }
    const result = await importing

    expect(result.imported).toHaveLength(1)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:added', session.getTapes())
    expect(session.getTapes()[0]).toMatchObject({ archivedAtUtc: '2026-01-02T00:00:00.000Z', order: -12 })
    await session.persistNow()
    expect(await savedTapes()).toEqual(session.getTapes())
  })
})
