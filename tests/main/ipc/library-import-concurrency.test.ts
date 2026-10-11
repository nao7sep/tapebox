import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSchema, type Tape } from '@shared/domain'
import type { ImportResult } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { inEnglish } from '../../helpers/i18n'

const state = vi.hoisted(() => ({
  libraryDir: '', catalog: '', heldCopy: '', heldAccess: '', heldCatalog: '', heldUnlink: '', heldRead: '',
  exclusiveCopies: false, readAfterBytes: false,
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
vi.mock('@main/paths', () => ({ paths: { get catalog() { return state.catalog } } }))
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
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      if (args[0] === state.heldAccess) { state.held(); await state.release }
      return actual.access(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      if (args[0] !== state.heldRead || args[1] !== 'r') return file
      return new Proxy(file, {
        get: (target, key) => {
          if (key === 'read') return async (...readArgs: unknown[]) => {
            const position = readArgs[3]
            if (!state.readAfterBytes || (typeof position === 'number' && position > 0)) {
              state.held()
              await state.release
              throw new Error('source copy read failed')
            }
            return Reflect.apply(target.read, target, readArgs)
          }
          const member = Reflect.get(target, key, target) as unknown
          return typeof member === 'function' ? member.bind(target) : member
        },
      })
    },
  }
})
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    directorySupportsHardLinks: async (...args: Parameters<typeof actual.directorySupportsHardLinks>) =>
      state.exclusiveCopies ? false : actual.directorySupportsHardLinks(...args),
    copyFileNoOverwrite: async (...args: Parameters<typeof actual.copyFileNoOverwrite>) => {
      await actual.copyFileNoOverwrite(...args)
      if (args[1] === state.heldCopy) { state.held(); await state.release }
    },
    unlinkFiles: async (...args: Parameters<typeof actual.unlinkFiles>) => {
      if (args[0].includes(state.heldUnlink)) {
        state.heldUnlink = ''
        state.held()
        await state.release
      }
      return actual.unlinkFiles(...args)
    },
  }
})
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJson: async (...args: Parameters<typeof actual.writeManagedJson>) => {
      if (args[0] === state.heldCatalog) {
        state.heldCatalog = ''
        state.held()
        await state.release
      }
      return actual.writeManagedJson(...args)
    },
  }
})

import { registerLibraryHandlers } from '@main/ipc/library'
import * as session from '@main/store/session'

let root: string
let sourceDir: string

function hold(kind: 'heldCopy' | 'heldAccess' | 'heldCatalog' | 'heldUnlink' | 'heldRead', path: string): { started: Promise<void>; release: () => void } {
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
  state.heldAccess = ''
  state.heldCatalog = ''
  state.heldUnlink = ''
  state.heldRead = ''
  state.exclusiveCopies = false
  state.readAfterBytes = false
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

describe('concurrent bundle admission at the catalog boundary', () => {
  it('keeps one row for the same source and removes only the refused import\'s created bundle, including its poster', async () => {
    const firstPath = await stageBundle(sourceDir, 'first', 'https://www.youtube.com/watch?v=shared&si=tracking', true)
    const secondPath = await stageBundle(sourceDir, 'second', 'https://www.youtube.com/watch?v=shared')
    const gate = hold('heldCopy', join(state.libraryDir, 'first.jpg'))
    const first = importBundle(firstPath)
    let second!: ImportResult
    try {
      await gate.started
      second = await importBundle(secondPath)
    } finally { gate.release() }
    const refused = await first

    expect(refused.imported).toEqual([])
    expect(refused.issues.map((issue) => inEnglish(issue.reason))).toEqual(['Already in the library.'])
    expect(session.getTapes()).toEqual(second.imported)
    expect(await savedTapes()).toEqual(second.imported)
    expect((await readdir(state.libraryDir)).sort()).toEqual(['second.json', 'second.mp4'])
    expect((await readdir(sourceDir)).sort()).toEqual(['first.jpg', 'first.json', 'first.mp4', 'second.json', 'second.mp4'])
  })

  it.each([false, true])('retains settled files adopted while its poster copy waits, then refuses their duplicate filenames (poster referenced: %s)', async (posterReferenced) => {
    const source = await stageBundle(sourceDir, 'shared', 'https://example.test/first', true)
    const gate = hold('heldCopy', join(state.libraryDir, 'shared.jpg'))
    const copying = importBundle(source)
    let adopted!: ImportResult
    try {
      await gate.started
      const adoptedPath = join(state.libraryDir, 'shared.json')
      const sidecar = JSON.parse(await readFile(adoptedPath, 'utf8')) as { tapebox: Record<string, unknown> }
      sidecar.tapebox.sourceUrl = 'https://example.test/adopted'
      if (!posterReferenced) sidecar.tapebox.thumbnailFilename = null
      await writeFile(adoptedPath, JSON.stringify(sidecar))
      adopted = await importBundle(adoptedPath)
    } finally { gate.release() }
    const refused = await copying

    expect(refused.imported).toEqual([])
    expect(refused.issues.map((issue) => inEnglish(issue.reason))).toEqual([
      "Another tape in the library already uses the file name shared.mp4. Rename this bundle's files, then import it again.",
    ])
    expect(session.getTapes()).toEqual(adopted.imported)
    expect(await savedTapes()).toEqual(adopted.imported)
    expect(adopted.imported[0]!.thumbnailFilename).toBeNull()
    expect(adopted.issues.map((issue) => issue.reason.key)).toEqual(posterReferenced ? ['import.thumbnailNameTaken'] : [])
    expect((await readdir(state.libraryDir)).sort()).toEqual(['shared.json', 'shared.mp4'])
    expect(await readFile(join(state.libraryDir, 'shared.mp4'), 'utf8')).toBe('media:shared')
    expect(JSON.parse(await readFile(join(state.libraryDir, 'shared.json'), 'utf8')).tapebox.sourceUrl).toBe('https://example.test/adopted')
  })

  it('keeps a pending poster for its copying bundle while an independent import omits it', async () => {
    const source = await stageBundle(sourceDir, 'first', 'https://example.test/first', true)
    const gate = hold('heldCopy', join(state.libraryDir, 'first.jpg'))
    const copying = importBundle(source)
    let adopted!: ImportResult
    try {
      await gate.started
      const adopter = await stageBundle(state.libraryDir, 'other', 'https://example.test/other')
      const sidecar = JSON.parse(await readFile(adopter, 'utf8')) as { tapebox: Record<string, unknown> }
      sidecar.tapebox.thumbnailFilename = 'first.jpg'
      await writeFile(adopter, JSON.stringify(sidecar))
      adopted = await importBundle(adopter)
    } finally { gate.release() }
    const result = await copying

    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]!.thumbnailFilename).toBe('first.jpg')
    expect(result.issues).toEqual([])
    expect(adopted.imported[0]!.thumbnailFilename).toBeNull()
    expect(adopted.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailNameTaken'])
    expect(await savedTapes()).toEqual(session.getTapes())
    expect(await readFile(join(state.libraryDir, 'first.jpg'), 'utf8')).toBe('poster:first')
  })

  it.each(['before retirement', 'during retirement'] as const)('refuses in-place adoption started %s while rollback owns a pending physical media deletion', async (startedAt) => {
    await writeFile(state.catalog, JSON.stringify({ formatVersion: 1, tapes: [], boxes: [] }))
    const source = await stageBundle(sourceDir, 'clip', 'https://example.test/copying')
    const sourceText = await readFile(source, 'utf8')
    const existing = join(state.libraryDir, 'clip.json')
    const sidecar = JSON.parse(sourceText) as { tapebox: Record<string, unknown> }
    sidecar.tapebox.sourceUrl = 'https://example.test/adopting'
    const existingText = JSON.stringify(sidecar)
    await writeFile(existing, existingText)
    const waitingAccess = startedAt === 'before retirement' ? hold('heldAccess', join(state.libraryDir, 'clip.mp4')) : undefined
    const inPlace = waitingAccess ? importBundle(existing) : undefined
    await waitingAccess?.started
    const gate = hold('heldUnlink', join(state.libraryDir, 'clip.mp4'))
    const copying = importBundle(source)
    let refused!: ImportResult
    try {
      await gate.started
      expect(await readFile(join(state.libraryDir, 'clip.mp4'), 'utf8')).toBe('media:clip')
      waitingAccess?.release()
      refused = await (inPlace ?? importBundle(existing))
    } finally {
      waitingAccess?.release()
      gate.release()
    }
    const rolledBack = await copying

    expect(rolledBack.imported).toEqual([])
    expect(rolledBack.issues.map((issue) => issue.reason.key)).toEqual(['import.copyFailed'])
    expect(refused.imported).toEqual([])
    expect(refused.issues.map((issue) => issue.reason.key)).toEqual(['import.nameTaken'])
    expect(await savedTapes()).toEqual([])
    expect(session.getTapes()).toEqual([])
    expect(await readdir(state.libraryDir)).toEqual(['clip.json'])
    expect(await readFile(existing, 'utf8')).toBe(existingText)
    expect(await readFile(source, 'utf8')).toBe(sourceText)
    expect(await readFile(join(sourceDir, 'clip.mp4'), 'utf8')).toBe('media:clip')
  })

  it('omits a poster whose physical deletion is pending without refusing an otherwise independent import', async () => {
    const source = await stageBundle(sourceDir, 'first', 'https://example.test/same', true)
    const winner = await stageBundle(sourceDir, 'winner', 'https://example.test/same')
    const copiedPoster = hold('heldCopy', join(state.libraryDir, 'first.jpg'))
    const copying = importBundle(source)
    let deletingPoster: ReturnType<typeof hold> | undefined
    let independent!: ImportResult
    try {
      await copiedPoster.started
      await importBundle(winner)
      deletingPoster = hold('heldUnlink', join(state.libraryDir, 'first.jpg'))
      copiedPoster.release()
      await deletingPoster.started
      const independentPath = await stageBundle(state.libraryDir, 'independent', 'https://example.test/independent')
      const sidecar = JSON.parse(await readFile(independentPath, 'utf8')) as { tapebox: Record<string, unknown> }
      sidecar.tapebox.thumbnailFilename = 'first.jpg'
      await writeFile(independentPath, JSON.stringify(sidecar))
      independent = await importBundle(independentPath)
    } finally {
      copiedPoster.release()
      deletingPoster?.release()
    }
    const rolledBack = await copying

    expect(rolledBack.imported).toEqual([])
    expect(independent.imported).toHaveLength(1)
    expect(independent.imported[0]!.thumbnailFilename).toBeNull()
    expect(independent.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailNameTaken'])
    expect(await savedTapes()).toEqual(session.getTapes())
    expect((await readdir(state.libraryDir)).sort()).toEqual(['independent.json', 'independent.mp4', 'winner.json', 'winner.mp4'])
    expect(await readFile(join(sourceDir, 'first.jpg'), 'utf8')).toBe('poster:first')
  })

  it('keeps the referenced originals when an in-place bundle loses a source race', async () => {
    const original = await stageBundle(state.libraryDir, 'original', 'https://example.test/same')
    const other = await stageBundle(sourceDir, 'other', 'https://example.test/same')
    const before = await readFile(original, 'utf8')
    const gate = hold('heldAccess', join(state.libraryDir, 'original.mp4'))
    const inPlace = importBundle(original)
    let winner!: ImportResult
    try {
      await gate.started
      winner = await importBundle(other)
    } finally { gate.release() }
    const refused = await inPlace

    expect(refused.imported).toEqual([])
    expect(refused.issues.map((issue) => inEnglish(issue.reason))).toEqual(['Already in the library.'])
    expect(await savedTapes()).toEqual(winner.imported)
    expect(await readFile(original, 'utf8')).toBe(before)
    expect(await readFile(join(state.libraryDir, 'original.mp4'), 'utf8')).toBe('media:original')
  })

  it.each(['organization', 'removal'] as const)('announces only current surviving rows after %s changes during the catalog save', async (change) => {
    const path = await stageBundle(sourceDir, 'pending', 'https://example.test/pending')
    const gate = hold('heldCatalog', state.catalog)
    const importing = importBundle(path)
    let removing: Promise<unknown> | undefined
    try {
      await gate.started
      const listed = await handlers.get('library:list')!(undefined) as Tape[]
      expect(listed).toHaveLength(1)
      if (change === 'organization') {
        session.upsertTape({ ...listed[0]!, archivedAtUtc: '2026-01-02T00:00:00.000Z', order: -12 })
      } else {
        removing = handlers.get('library:remove')!({ tapeIds: [listed[0]!.id], deleteFiles: false })
        expect(await handlers.get('library:list')!(undefined)).toEqual([])
      }
    } finally { gate.release() }
    const result = await importing
    await removing

    expect(result.imported, 'the receipt records the accepted import even if it was subsequently removed').toHaveLength(1)
    if (change === 'organization') {
      expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:added', session.getTapes())
      expect(session.getTapes()[0]).toMatchObject({ archivedAtUtc: '2026-01-02T00:00:00.000Z', order: -12 })
    } else {
      expect(emit.mock.calls.filter(([channel]) => channel === 'tapes:added')).toEqual([])
      expect(session.getTapes()).toEqual([])
    }
    await session.persistNow()
    expect(await savedTapes()).toEqual(session.getTapes())
  })

  it.each(['media', 'sidecar'] as const)('refuses adoption of an unsettled exclusive %s copy that removes its visible destination on read failure', async (artifact) => {
    await writeFile(state.catalog, JSON.stringify({ formatVersion: 1, tapes: [], boxes: [] }))
    const source = await stageBundle(sourceDir, 'clip', 'https://example.test/copying')
    const sourceText = await readFile(source, 'utf8')
    const existing = join(state.libraryDir, 'clip.json')
    let existingText: string | undefined
    if (artifact === 'media') {
      const sidecar = JSON.parse(sourceText) as { tapebox: Record<string, unknown> }
      sidecar.tapebox.sourceUrl = 'https://example.test/adopting'
      existingText = JSON.stringify(sidecar)
      await writeFile(existing, existingText)
    }
    state.exclusiveCopies = true
    state.readAfterBytes = artifact === 'sidecar'
    const gate = hold('heldRead', artifact === 'media' ? join(sourceDir, 'clip.mp4') : source)
    const copying = importBundle(source)
    let refused!: ImportResult
    try {
      await gate.started
      const visible = artifact === 'media' ? join(state.libraryDir, 'clip.mp4') : existing
      expect(await readFile(visible, 'utf8')).toBe(artifact === 'media' ? '' : sourceText)
      refused = await importBundle(existing)
    } finally { gate.release() }
    const failed = await copying

    expect(failed.imported).toEqual([])
    expect(failed.issues.map((issue) => issue.reason.key)).toEqual(['import.copyFailed'])
    expect(refused.imported).toEqual([])
    expect(refused.issues.map((issue) => issue.reason.key)).toEqual(['import.nameTaken'])
    expect(await savedTapes()).toEqual([])
    expect(session.getTapes()).toEqual([])
    expect(await readdir(state.libraryDir)).toEqual(artifact === 'media' ? ['clip.json'] : [])
    if (existingText) expect(await readFile(existing, 'utf8')).toBe(existingText)
    expect(await readFile(source, 'utf8')).toBe(sourceText)
    expect(await readFile(join(sourceDir, 'clip.mp4'), 'utf8')).toBe('media:clip')
  })

  it('omits an unsettled exclusive poster copy before its primitive removes the destination on read failure', async () => {
    const source = await stageBundle(sourceDir, 'clip', 'https://example.test/copying', true)
    const independentPath = await stageBundle(state.libraryDir, 'independent', 'https://example.test/independent')
    const sidecar = JSON.parse(await readFile(independentPath, 'utf8')) as { tapebox: Record<string, unknown> }
    sidecar.tapebox.thumbnailFilename = 'clip.jpg'
    const independentText = JSON.stringify(sidecar)
    await writeFile(independentPath, independentText)
    state.exclusiveCopies = true
    const gate = hold('heldRead', join(sourceDir, 'clip.jpg'))
    const copying = importBundle(source)
    let independent!: ImportResult
    try {
      await gate.started
      expect(await readFile(join(state.libraryDir, 'clip.jpg'), 'utf8')).toBe('')
      independent = await importBundle(independentPath)
    } finally { gate.release() }
    const imported = await copying

    expect(imported.imported).toHaveLength(1)
    expect(imported.imported[0]!.thumbnailFilename).toBeNull()
    expect(imported.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailCopyFailed'])
    expect(independent.imported).toHaveLength(1)
    expect(independent.imported[0]!.thumbnailFilename).toBeNull()
    expect(independent.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailNameTaken'])
    expect(await savedTapes()).toEqual(session.getTapes())
    expect(await readFile(independentPath, 'utf8')).toBe(independentText)
    expect(await readFile(join(sourceDir, 'clip.jpg'), 'utf8')).toBe('poster:clip')
    expect((await readdir(state.libraryDir)).sort()).toEqual(['clip.json', 'clip.mp4', 'independent.json', 'independent.mp4'])
  })
})
