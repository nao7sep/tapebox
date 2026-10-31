vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAPE_FILE, type Tape } from '@shared/domain'
import { compareInbox } from '@shared/order'
import type { ImportResult } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  collectionDir: '', heldCopy: '', heldTapeFile: '',
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
vi.mock('@main/store/config', () => ({
  getCollectionDir: () => state.collectionDir,
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
      // The copy lands in a tape folder named by an id the test cannot know, so it is held by its file name.
      if (args[1].startsWith(state.collectionDir) && basename(args[1]) === state.heldCopy) { state.held(); await state.release }
    },
  }
})
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      // A tape's own file sits in a folder named by an id the test cannot know, so it is held by its file name.
      if (state.heldTapeFile !== '' && basename(args[0]) === state.heldTapeFile) {
        state.heldTapeFile = ''
        state.held()
        await state.release
      }
      return actual.writeManagedJsonBytes(...args)
    },
  }
})

import { registerCollectionHandlers } from '@main/ipc/collection'
import * as session from '@main/store/session'

let root: string
let sourceDir: string

function hold(kind: 'heldCopy' | 'heldTapeFile', path: string): { started: Promise<void>; release: () => void } {
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
  return await handlers.get('collection:import')!({ paths: [path] }) as ImportResult
}

const byId = (a: Tape, b: Tape) => a.id.localeCompare(b.id)

/** The tapes as the collection on disk holds them, by id. */
async function savedTapes(): Promise<Tape[]> {
  const read = await session.readCollection(state.collectionDir)
  return [...read.session.tapes].sort(byId)
}

/** The live tapes as they should be saved, by id. */
function durableTapes(): Tape[] {
  return session.getTapes().map(session.durableTape).sort(byId)
}

beforeEach(async () => {
  handlers.clear()
  root = await mkdtemp(join(tmpdir(), 'tapebox-import-concurrency-'))
  sourceDir = join(root, 'source')
  state.collectionDir = join(root, 'collection')
  state.heldCopy = ''
  state.heldTapeFile = ''
  state.release = null
  emit.mockClear()
  await mkdir(sourceDir)
  // A collection that already holds Inbox tapes has its inbox/ folder.
  await mkdir(join(state.collectionDir, 'inbox'), { recursive: true })
  await session.loadSession()
  registerCollectionHandlers()
})

afterEach(async () => {
  await session.persistNow({ quitting: true })
  await rm(root, { recursive: true, force: true })
})

describe('bundle import beside session changes', () => {
  it('keeps a batch in selection order while a URL added during its copy waits sorts by its own time', async () => {
    const firstPath = await stageBundle(sourceDir, 'first', 'https://example.test/first')
    const secondPath = await stageBundle(sourceDir, 'second', 'https://example.test/second')
    const gate = hold('heldCopy', 'second.mp4')
    const batch = handlers.get('collection:import')!({ paths: [firstPath, secondPath] })
    const added = 'url0000001'
    try {
      await gate.started
      // The first batch row has been admitted while the second is still copying.
      const [first] = session.getTapes()
      expect(first?.name).toBe('first')
      // A URL added meanwhile is added now, after the bundles' own times.
      session.upsertTape({ ...first!, id: added, sourceUrl: 'https://example.test/added', state: 'queued', name: 'concurrent',
        filename: null, sidecarFilename: null, thumbnailFilename: null, addedAtUtc: '2026-02-01T00:00:00.000Z', addedIndex: 0 })
    } finally { gate.release() }
    const result = await batch as ImportResult
    expect(result.imported.map((tape) => tape.name)).toEqual(['first', 'second'])
    expect(result.imported.map((tape) => tape.addedIndex)).toEqual([0, 1])
    const inbox = session.getTapes().filter((tape) => !tape.shelved).sort(compareInbox)
    expect(inbox.map((tape) => tape.name)).toEqual(['concurrent', 'first', 'second'])
    expect(inbox[0]?.id).toBe(added)
    const batchAnnouncement = emit.mock.calls.filter(([channel]) => channel === 'tapes:added').at(-1)![1] as Tape[]
    expect(batchAnnouncement).toEqual(inbox.slice(1))
    await session.persistNow()
    expect(await savedTapes()).toEqual(durableTapes())
  })

  it('announces the current rows after changes made during the collection save', async () => {
    const path = await stageBundle(sourceDir, 'pending', 'https://example.test/pending')
    const gate = hold('heldTapeFile', TAPE_FILE)
    const importing = importBundle(path)
    try {
      await gate.started
      const listed = session.getTapes()
      expect(listed).toHaveLength(1)
      session.upsertTape({ ...listed[0]!, title: 'Retitled' })
    } finally { gate.release() }
    const result = await importing

    expect(result.imported).toHaveLength(1)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:added', session.getTapes())
    expect(session.getTapes()[0]).toMatchObject({ title: 'Retitled' })
    await session.persistNow()
    expect(await savedTapes()).toEqual(durableTapes())
  })
})
