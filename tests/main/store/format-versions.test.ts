import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDependencies } from '@shared/dependencies'
import { defaultLayout } from '@shared/layout'
import { header } from '../../helpers/file-header'

// Each JSON store's format version (store-recovery-conventions), through the
// real store over a throwaway storage root: a file without its header is
// unreadable, what the store writes carries it and reads back, and
// a newer file is refused and left byte-identical, with nothing written over it.

vi.mock('@main/io/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))

const prevRoot = process.env.TAPEBOX_DATA_DIR
const prevKey = process.env.OPENAI_API_KEY
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-format-versions-'))
  process.env.TAPEBOX_DATA_DIR = root
  delete process.env.OPENAI_API_KEY
  vi.resetModules()
})

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = prevRoot
  if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
  await rm(root, { recursive: true, force: true })
})

/** A fresh process's view of the stores: every module reloaded over `root`. */
async function relaunch<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules()
  return load()
}

async function stored(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** Write a newer-format file and return its exact text, for the byte check. */
async function writeNewer(kind: Parameters<typeof header>[0], path: string, body: Record<string, unknown>, mode?: number): Promise<string> {
  const text = JSON.stringify({ ...header(kind, 2), ...body, addedByNewerBuild: true })
  await writeFile(path, text, 'utf8')
  if (mode !== undefined) await chmod(path, mode)
  return text
}

const NEWER = { name: 'NewerFormatError', version: 2 }
const BOX = { id: 'box1234567', name: 'Box', order: 0 }
const TAPE = {
  id: 'Tape123456', sourceUrl: 'https://example.test/watch', state: 'failed', addedAtUtc: '2026-07-08T00:00:00.000Z',
  addedIndex: 0, sourceId: null, extractor: null, title: null, uploader: null, durationSeconds: null, chapterCount: 0,
  probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
  downloadStartedAtUtc: null, downloadedAtUtc: null, name: null, renamedAtUtc: null,
  failureCode: null, pausedAtUtc: null, failedAtUtc: '2026-07-08T00:00:01.000Z', lastError: 'gone',
}

describe('shelf.json', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'collection'), { recursive: true })
    await (await import('@main/store/config')).loadSettings()
  })
  const session = () => import('@main/store/session')
  const path = () => join(root, 'collection', 'shelf.json')
  const SHELF_BOX = { id: BOX.id, name: BOX.name, tapeIds: [] }

  it('sets aside a file without its header, like any unreadable one', async () => {
    const text = JSON.stringify({ boxes: [SHELF_BOX], loose: [] })
    await writeFile(path(), text)
    const store = await session()
    expect(await store.loadSession()).toMatchObject({ status: 'recovered' })
    expect(store.getBoxes()).toEqual([])
    const aside = (await readdir(dirname(path()))).find((name) => name.startsWith('shelf-') && name.endsWith('.invalid'))
    expect(await readFile(join(dirname(path()), aside!), 'utf8')).toBe(text)
  })

  it('sets aside a file of a lower version, another kind or another owner', async () => {
    for (const format of [header('shelf', 0).format, { owner: 'tapebox', kind: 'tape', version: 1 }, { owner: 'gptimg', kind: 'shelf', version: 1 }, 'shelf']) {
      await writeFile(path(), JSON.stringify({ format, boxes: [SHELF_BOX], loose: [] }))
      const store = await relaunch(async () => {
        await (await import('@main/store/config')).loadSettings()
        return session()
      })
      expect(await store.loadSession(), JSON.stringify(format)).toMatchObject({ status: 'recovered' })
      expect(store.getBoxes()).toEqual([])
      // Set-aside names carry the second, so clear this one before the next.
      for (const name of await readdir(dirname(path()))) if (name.endsWith('.invalid')) await rm(join(dirname(path()), name))
    }
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await session()
    await store.loadSession()
    store.upsertBox(BOX)
    expect(await store.persistNow()).toBe(true)
    expect(Object.keys(await stored(path())).slice(0, 2)).toEqual(['format', 'writer'])
    expect(await stored(path())).toMatchObject(header('shelf'))

    const relaunched = await relaunch(async () => {
      await (await import('@main/store/config')).loadSettings()
      return session()
    })
    expect(await relaunched.loadSession()).toMatchObject({ status: 'loaded' })
    expect(relaunched.getBoxes()).toEqual([BOX])
  })

  it('refuses a newer file, naming it, and leaves it byte-identical', async () => {
    const text = await writeNewer('shelf', path(), { boxes: [], loose: [] })
    const store = await session()
    await expect(store.loadSession()).rejects.toMatchObject({ ...NEWER, path: path() })
    expect(await store.persistNow()).toBe(true)
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(dirname(path()))).toEqual(['shelf.json'])
  })
})

describe('tape.json', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'collection', 'inbox', TAPE.id), { recursive: true })
    await writeFile(join(root, 'collection', 'shelf.json'), JSON.stringify({ ...header('shelf'), boxes: [], loose: [] }))
    await (await import('@main/store/config')).loadSettings()
  })
  const session = () => import('@main/store/session')
  const path = () => join(root, 'collection', 'inbox', TAPE.id, 'tape.json')

  it('reports a file without its header as damaged and leaves it as it is', async () => {
    const text = JSON.stringify(TAPE)
    await writeFile(path(), text)
    const store = await session()
    expect(await store.loadSession()).toMatchObject({
      status: 'loaded',
      tapeCount: 0,
      damaged: [{ id: TAPE.id, path: path(), reason: expect.stringMatching(/no format header/) }],
    })
    expect(await readFile(path(), 'utf8')).toBe(text)
  })

  it('writes format 1 first and reads it back', async () => {
    await writeFile(path(), JSON.stringify({ ...header('tape'), ...TAPE }))
    const store = await session()
    await store.loadSession()
    store.upsertTape({ ...store.getTapes()[0]!, title: 'Titled' })
    expect(await store.persistNow()).toBe(true)
    expect(Object.keys(await stored(path())).slice(0, 2)).toEqual(['format', 'writer'])

    const relaunched = await relaunch(async () => {
      await (await import('@main/store/config')).loadSettings()
      return session()
    })
    expect(await relaunched.loadSession()).toMatchObject({ status: 'loaded', tapeCount: 1 })
    expect(relaunched.getTapes()[0]).toMatchObject({ id: TAPE.id, title: 'Titled' })
  })

  // One tape's newer file does not stop the collection: that tape is reported as
  // damaged and its folder is left exactly as it is.
  it('reports a newer file as damaged and leaves it byte-identical', async () => {
    const text = await writeNewer('tape', path(), TAPE)
    const store = await session()
    expect(await store.loadSession()).toMatchObject({
      status: 'loaded',
      tapeCount: 0,
      damaged: [{ id: TAPE.id, path: path(), reason: expect.stringMatching(/format 2/) }],
    })
    expect(store.getTapes()).toEqual([])
    store.upsertBox(BOX)
    expect(await store.persistNow()).toBe(true)
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(dirname(path()))).toEqual(['tape.json'])
  })
})

describe('config.json', () => {
  const config = () => import('@main/store/config')
  const path = () => join(root, 'config.json')

  it('sets aside a file without its header and uses the defaults', async () => {
    const text = JSON.stringify({ autoplay: false })
    await writeFile(path(), text)
    const store = await config()
    expect(await store.loadSettings()).toMatchObject({ status: 'recovered' })
    expect(store.getSettings().autoplay).toBe(true)
    const aside = (await readdir(root)).find((name) => name.endsWith('.invalid'))
    expect(await readFile(join(root, aside!), 'utf8')).toBe(text)
  })

  it('stops, naming the file and leaving it in place, when it cannot be opened', async () => {
    await mkdir(path())
    const store = await config()
    await expect(store.loadSettings()).rejects.toMatchObject({ name: 'StoreAccessError', path: path() })
    expect(await readdir(root)).toEqual(['config.json'])
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await config()
    await store.loadSettings()
    await store.updateSettings({ autoplay: false })
    expect(await stored(path())).toEqual({ ...header('config'), autoplay: false })

    const relaunched = await relaunch(config)
    expect(await relaunched.loadSettings()).toEqual({ status: 'loaded', settingsKept: false })
    expect(relaunched.getSettings().autoplay).toBe(false)
  })

  it('refuses a newer file, naming it, and leaves it byte-identical', async () => {
    const text = await writeNewer('config', path(), { autoplay: false, language: 'ja' })
    const store = await config()
    await expect(store.loadSettings()).rejects.toMatchObject({ ...NEWER, path: path() })
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(root)).toEqual(['config.json'])

    const { readSavedLanguagePreference } = await import('@main/core/saved-language')
    expect(readSavedLanguagePreference(text), 'its language is not read either').toBe('system')
  })
})

describe('layout.json', () => {
  const layout = () => import('@main/store/layout')
  const path = () => join(root, 'layout.json')

  it('uses the defaults for a file without its header', async () => {
    await writeFile(path(), JSON.stringify({ leftPaneWidth: 400 }))
    const store = await layout()
    await store.loadLayout()
    expect(store.getLayout()).toEqual(defaultLayout)
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await layout()
    await store.loadLayout()
    store.updateLayout({ leftPaneWidth: 410 })
    await store.persistNow()
    expect(Object.keys(await stored(path())).slice(0, 2)).toEqual(['format', 'writer'])
    expect(await stored(path())).toMatchObject({ ...header('layout'), leftPaneWidth: 410 })

    const relaunched = await relaunch(layout)
    await relaunched.loadLayout()
    expect(relaunched.getLayout().leftPaneWidth).toBe(410)
  })

  it('uses the defaults for a newer file and never writes it', async () => {
    const text = await writeNewer('layout', path(), { leftPaneWidth: 400 })
    const store = await layout()
    await store.loadLayout()
    expect(store.getLayout()).toEqual(defaultLayout)

    store.updateLayout({ leftPaneWidth: 420 })
    await store.persistNow()
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(root)).toEqual(['layout.json'])
  })
})

describe('dependencies.json', () => {
  const dependencies = () => import('@main/store/dependencies')
  const path = () => join(root, 'dependencies.json')
  const FACT = { latestKnownVersion: '2026.09.01', lastCheckedAtUtc: '2026-09-01T00:00:00.000Z' }

  it('uses fresh facts for a file without its header', async () => {
    await writeFile(path(), JSON.stringify({ ...defaultDependencies(), ffmpeg: FACT }))
    const store = await dependencies()
    await store.loadDependencies()
    expect(store.getDependencies()).toEqual(defaultDependencies())
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await dependencies()
    await store.loadDependencies()
    await store.mutateDependencies(() => ({ ffmpeg: FACT }))
    expect(Object.keys(await stored(path())).slice(0, 2)).toEqual(['format', 'writer'])
    expect(await stored(path())).toMatchObject({ ...header('dependencies'), ffmpeg: FACT })

    const relaunched = await relaunch(dependencies)
    await relaunched.loadDependencies()
    expect(relaunched.getDependencies().ffmpeg).toEqual(FACT)
  })

  it('uses fresh facts for a newer file and never writes it', async () => {
    const text = await writeNewer('dependencies', path(), { ...defaultDependencies(), ffmpeg: FACT })
    const store = await dependencies()
    await store.loadDependencies()
    expect(store.getDependencies()).toEqual(defaultDependencies())

    await store.mutateDependencies(() => ({ ffmpeg: FACT }))
    expect(store.getDependencies().ffmpeg, 'the session still learns the fact').toEqual(FACT)
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(root)).toEqual(['dependencies.json'])
  })
})

describe('api-keys.json', () => {
  const apiKeys = () => import('@main/services/api-keys')
  const path = () => join(root, 'api-keys.json')

  it('resolves no key from a file without its header and leaves it in place', async () => {
    const text = JSON.stringify({ keys: { openai: 'sk-plain' } })
    await writeFile(path(), text, { mode: 0o600 })
    const store = await apiKeys()
    expect(await store.resolveApiKey('openai')).toBeNull()
    expect(await readFile(path(), 'utf8')).toBe(text)
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await apiKeys()
    await store.writeApiKey('openai', 'sk-saved')
    expect(Object.keys(await stored(path()))).toEqual(['format', 'writer', 'keys'])
    expect(await stored(path())).toMatchObject(header('apiKeys'))

    const relaunched = await relaunch(apiKeys)
    expect(await relaunched.resolveApiKey('openai')).toBe('sk-saved')
  })

  it('treats a newer file as holding no key, refuses to change it, and leaves it byte-identical', async () => {
    const text = await writeNewer('apiKeys', path(), { keys: { openai: 'sk-newer' } }, 0o600)
    const store = await apiKeys()
    expect(await store.resolveApiKey('openai')).toBeNull()

    const refusal = { name: 'UserFacingError', userMessage: { key: 'errors.fileNewer', values: { name: 'api-keys.json' } } }
    await expect(store.writeApiKey('openai', 'sk-other')).rejects.toMatchObject(refusal)
    await expect(store.clearApiKey('openai')).rejects.toMatchObject(refusal)
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(root)).toEqual(['api-keys.json'])
  })
})
