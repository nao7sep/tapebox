import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDependencies } from '@shared/dependencies'
import { defaultLayout } from '@shared/layout'

// Each JSON store's format version (store-recovery-conventions), through the
// real store over a throwaway storage root: a file with no marker reads as 1,
// what the store writes carries 1 and reads back, and a newer file is refused
// and left byte-identical, with nothing written over it.

vi.mock('@main/io/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn(), recordBeforeExit: vi.fn() }))

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
async function writeNewer(path: string, body: Record<string, unknown>, mode?: number): Promise<string> {
  const text = JSON.stringify({ formatVersion: 2, ...body, addedByNewerBuild: true })
  await writeFile(path, text, 'utf8')
  if (mode !== undefined) await chmod(path, mode)
  return text
}

const NEWER = { name: 'NewerFormatError', version: 2 }
const BOX = { id: 'box1234567', name: 'Box', order: 0 }

describe('catalog.json', () => {
  const session = () => import('@main/store/session')
  const path = () => join(root, 'catalog.json')

  it('reads a file with no marker as format 1', async () => {
    await writeFile(path(), JSON.stringify({ tapes: [], boxes: [BOX] }))
    const store = await session()
    expect(await store.loadSession()).toEqual({ status: 'loaded', tapeCount: 0 })
    expect(store.getBoxes()).toEqual([BOX])
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await session()
    await store.loadSession()
    store.upsertBox(BOX)
    expect(await store.persistNow()).toBe(true)
    expect(Object.keys(await stored(path()))[0]).toBe('formatVersion')
    expect(await stored(path())).toMatchObject({ formatVersion: 1 })

    const relaunched = await relaunch(session)
    expect(await relaunched.loadSession()).toMatchObject({ status: 'loaded' })
    expect(relaunched.getBoxes()).toEqual([BOX])
  })

  it('refuses a newer file, naming it, and leaves it byte-identical', async () => {
    const text = await writeNewer(path(), { tapes: [], boxes: [] })
    const store = await session()
    await expect(store.loadSession()).rejects.toMatchObject({ ...NEWER, path: path() })
    expect(await store.persistNow()).toBe(true)
    store.persistNowSync()
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(root)).toEqual(['catalog.json'])
  })
})

describe('config.json', () => {
  const config = () => import('@main/store/config')
  const path = () => join(root, 'config.json')

  it('reads a file with no marker as format 1', async () => {
    await writeFile(path(), JSON.stringify({ autoplay: false }))
    const store = await config()
    expect(await store.loadSettings()).toEqual({ status: 'loaded' })
    expect(store.getSettings().autoplay).toBe(false)
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await config()
    await store.loadSettings()
    await store.updateSettings({ autoplay: false })
    expect(await stored(path())).toEqual({ formatVersion: 1, autoplay: false })

    const relaunched = await relaunch(config)
    expect(await relaunched.loadSettings()).toEqual({ status: 'loaded' })
    expect(relaunched.getSettings().autoplay).toBe(false)
  })

  it('refuses a newer file, naming it, and leaves it byte-identical', async () => {
    const text = await writeNewer(path(), { autoplay: false, language: 'ja' })
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

  it('reads a file with no marker as format 1', async () => {
    await writeFile(path(), JSON.stringify({ leftPaneWidth: 400 }))
    const store = await layout()
    await store.loadLayout()
    expect(store.getLayout().leftPaneWidth).toBe(400)
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await layout()
    await store.loadLayout()
    store.updateLayout({ leftPaneWidth: 410 })
    await store.persistNow()
    expect(Object.keys(await stored(path()))[0]).toBe('formatVersion')
    expect(await stored(path())).toMatchObject({ formatVersion: 1, leftPaneWidth: 410 })

    const relaunched = await relaunch(layout)
    await relaunched.loadLayout()
    expect(relaunched.getLayout().leftPaneWidth).toBe(410)
  })

  it('uses the defaults for a newer file and never writes it', async () => {
    const text = await writeNewer(path(), { leftPaneWidth: 400 })
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

  it('reads a file with no marker as format 1', async () => {
    await writeFile(path(), JSON.stringify({ ...defaultDependencies(), ffmpeg: FACT }))
    const store = await dependencies()
    await store.loadDependencies()
    expect(store.getDependencies().ffmpeg).toEqual(FACT)
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await dependencies()
    await store.loadDependencies()
    await store.mutateDependencies(() => ({ ffmpeg: FACT }))
    expect(Object.keys(await stored(path()))[0]).toBe('formatVersion')
    expect(await stored(path())).toMatchObject({ formatVersion: 1, ffmpeg: FACT })

    const relaunched = await relaunch(dependencies)
    await relaunched.loadDependencies()
    expect(relaunched.getDependencies().ffmpeg).toEqual(FACT)
  })

  it('uses fresh facts for a newer file and never writes it', async () => {
    const text = await writeNewer(path(), { ...defaultDependencies(), ffmpeg: FACT })
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

  it('reads a file with no marker as format 1', async () => {
    await writeFile(path(), JSON.stringify({ keys: { openai: 'sk-plain' } }), { mode: 0o600 })
    const store = await apiKeys()
    expect(await store.resolveApiKey('openai')).toBe('sk-plain')
  })

  it('writes format 1 first and reads it back', async () => {
    const store = await apiKeys()
    await store.writeApiKey('openai', 'sk-saved')
    expect(Object.keys(await stored(path()))).toEqual(['formatVersion', 'keys'])
    expect(await stored(path())).toMatchObject({ formatVersion: 1 })

    const relaunched = await relaunch(apiKeys)
    expect(await relaunched.resolveApiKey('openai')).toBe('sk-saved')
  })

  it('treats a newer file as holding no key, refuses to change it, and leaves it byte-identical', async () => {
    const text = await writeNewer(path(), { keys: { openai: 'sk-newer' } }, 0o600)
    const store = await apiKeys()
    expect(await store.resolveApiKey('openai')).toBeNull()

    const refusal = { name: 'UserFacingError', userMessage: { key: 'errors.fileNewer', values: { name: 'api-keys.json' } } }
    await expect(store.writeApiKey('openai', 'sk-other')).rejects.toMatchObject(refusal)
    await expect(store.clearApiKey('openai')).rejects.toMatchObject(refusal)
    expect(await readFile(path(), 'utf8')).toBe(text)
    expect(await readdir(root)).toEqual(['api-keys.json'])
  })
})
