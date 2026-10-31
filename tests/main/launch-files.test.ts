import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { header } from '../helpers/file-header'

// The launch's file check with the real JSON stores over a throwaway data root:
// every refused file is named in one stop, nothing is written, and the side
// stores' answers are passed through (store-recovery-conventions, What a
// refused file does).

vi.mock('@main/io/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn(), openBackupStore: vi.fn(async () => null) }))
vi.mock('@main/io/records', () => ({ flushRecords: vi.fn(async () => {}), recordsRefusal: () => null }))

const previousRoot = process.env.TAPEBOX_DATA_DIR
const previousKey = process.env.OPENAI_API_KEY
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-launch-files-'))
  process.env.TAPEBOX_DATA_DIR = root
  delete process.env.OPENAI_API_KEY
  vi.resetModules()
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = previousRoot
  if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey
  await rm(root, { recursive: true, force: true })
})

async function launch(overrides: Partial<import('@main/launch-files').LaunchLoaders> = {}) {
  const { LAUNCH_LOADERS, loadLaunchFiles } = await import('@main/launch-files')
  return loadLaunchFiles({ ...LAUNCH_LOADERS, afterSettings: async () => {}, ...overrides })
}

/** Every file under the root with its bytes, to prove nothing changed. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (name.isFile()) {
      const path = join(name.parentPath, name.name)
      out[path.slice(root.length)] = await readFile(path, 'utf8')
    }
  }
  return out
}

describe('loadLaunchFiles', () => {
  it('reads a fresh root without writing a file', async () => {
    await mkdir(join(root, 'collection'))
    const files = await launch()
    expect(files.settings).toEqual({ status: 'missing' })
    expect(files.session).toMatchObject({ status: 'empty', damaged: [] })
    expect(await snapshot()).toEqual({})
  })

  it('names every refused file in one stop, newer or unreadable, and writes nothing', async () => {
    await mkdir(join(root, 'collection'))
    await writeFile(join(root, 'api-keys.json'), '{ broken')
    await writeFile(join(root, 'layout.json'), JSON.stringify({ ...header('layout', 2), leftPaneWidth: 400 }))
    await writeFile(join(root, 'dependencies.json'), JSON.stringify({ ...header('dependencies', 2) }))
    await writeFile(join(root, 'collection', 'shelf.json'), JSON.stringify({ ...header('shelf', 2), boxes: [], loose: [] }))
    const before = await snapshot()

    await expect(launch()).rejects.toMatchObject({
      name: 'LaunchRefusedError',
      files: [
        { path: join(root, 'api-keys.json'), reason: 'unreadable' },
        { path: join(root, 'dependencies.json'), reason: 'newer' },
        { path: join(root, 'collection', 'shelf.json'), reason: 'newer' },
        { path: join(root, 'layout.json'), reason: 'newer' },
      ],
    })
    expect(await snapshot()).toEqual(before)
  })

  it('stops for an unreadable config.json without reading the collection it names', async () => {
    await writeFile(join(root, 'config.json'), '{ broken')
    const loadSession = vi.fn(async () => { throw new Error('not reached') })
    const afterSettings = vi.fn(async () => {})
    await expect(launch({ loadSession, afterSettings })).rejects.toMatchObject({
      files: [{ path: join(root, 'config.json'), reason: 'unreadable' }],
    })
    expect(loadSession).not.toHaveBeenCalled()
    expect(afterSettings).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{ broken')
  })

  it('stops for a newer tape file and for a newer records or backup database', async () => {
    const folder = join(root, 'collection', 'shelf', 'Newer00001')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'tape.json'), JSON.stringify({ ...header('tape', 2), id: 'Newer00001' }))
    await expect(launch({
      openRecords: async () => ({ path: '/r/records.sqlite3', reason: 'newer' }),
      openBackups: async () => ({ path: '/r/backups.sqlite3', reason: 'newer' }),
    })).rejects.toMatchObject({
      files: [
        { path: join(folder, 'tape.json'), reason: 'newer' },
        { path: '/r/records.sqlite3', reason: 'newer' },
        { path: '/r/backups.sqlite3', reason: 'newer' },
      ],
    })
  })

  it('starts on defaults for unreadable layout and tool facts, and passes an unreadable side store on to be told', async () => {
    await mkdir(join(root, 'collection'))
    await writeFile(join(root, 'layout.json'), '{ broken')
    await writeFile(join(root, 'dependencies.json'), '[]')
    const records = { path: '/r/records.sqlite3', reason: 'unreadable' } as const
    const backups = { path: '/r/backups.sqlite3', reason: 'unreadable' } as const
    const files = await launch({ openRecords: async () => records, openBackups: async () => backups })
    expect(files).toMatchObject({ records, backups })
  })

  it('names an unreadable tape file to be told, not stopping the launch', async () => {
    const folder = join(root, 'collection', 'inbox', 'Broken0001')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'tape.json'), '{ broken')
    const files = await launch()
    expect(files.session.damaged).toEqual([{ id: 'Broken0001', path: join(folder, 'tape.json'), reason: expect.any(String), newer: false }])
  })
})
