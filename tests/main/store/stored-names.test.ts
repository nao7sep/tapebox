import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The default folder, config.json's collection key and layout.json's Shelf pane
// key were stored under their old names before the rename to collection and
// Shelf. Launch converts each once; running it again changes nothing.

vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const prevHome = process.env.TAPEBOX_DATA_DIR
const roots: string[] = []

afterEach(() => {
  if (prevHome === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = prevHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-names-'))
  roots.push(root)
  process.env.TAPEBOX_DATA_DIR = root
  vi.resetModules()
  const { convertStoredNames } = await import('@main/store/stored-names')
  const { paths } = await import('@main/paths')
  return { root, paths, convertStoredNames }
}

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

describe('convertStoredNames', () => {
  it('moves library/ to collection/, replacing the empty one ensureDirs made', async () => {
    const { root, paths, convertStoredNames } = await freshRoot()
    mkdirSync(join(root, 'library', 'inbox'), { recursive: true })
    writeFileSync(join(root, 'library', 'shelf.json'), '{}')
    mkdirSync(paths.collection)
    await convertStoredNames()
    expect(readdirSync(root)).not.toContain('library')
    expect(readdirSync(paths.collection).sort()).toEqual(['inbox', 'shelf.json'])
    await convertStoredNames()
    expect(readdirSync(paths.collection).sort()).toEqual(['inbox', 'shelf.json'])
  })

  it('leaves both folders alone when collection/ already holds something', async () => {
    const { root, paths, convertStoredNames } = await freshRoot()
    mkdirSync(join(root, 'library'))
    writeFileSync(join(root, 'library', 'shelf.json'), '{"old":true}')
    mkdirSync(paths.collection)
    writeFileSync(join(paths.collection, 'shelf.json'), '{"new":true}')
    await convertStoredNames()
    expect(json(join(root, 'library', 'shelf.json'))).toEqual({ old: true })
    expect(json(join(paths.collection, 'shelf.json'))).toEqual({ new: true })
  })

  it('renames the stored keys in place and keeps a custom collection path', async () => {
    const { paths, convertStoredNames } = await freshRoot()
    writeFileSync(paths.config, JSON.stringify({ formatVersion: 1, autoplay: false, libraryDir: '/Volumes/Tapes', volume: 0.5 }))
    writeFileSync(paths.layout, JSON.stringify({ formatVersion: 1, leftPaneWidth: 400, archiveBoxesHeight: 300 }))
    await convertStoredNames()
    expect(Object.entries(json(paths.config))).toEqual([
      ['formatVersion', 1], ['autoplay', false], ['collectionDir', '/Volumes/Tapes'], ['volume', 0.5],
    ])
    expect(json(paths.layout)).toEqual({ formatVersion: 1, leftPaneWidth: 400, shelfBoxesHeight: 300 })
    const config = readFileSync(paths.config, 'utf8')
    await convertStoredNames()
    expect(readFileSync(paths.config, 'utf8')).toBe(config)
  })

  it('keeps the new key when a file holds both names', async () => {
    const { paths, convertStoredNames } = await freshRoot()
    writeFileSync(paths.config, JSON.stringify({ formatVersion: 1, libraryDir: '/old', collectionDir: '/new' }))
    await convertStoredNames()
    expect(json(paths.config)).toEqual({ formatVersion: 1, collectionDir: '/new' })
  })

  it('leaves unreadable, newer and missing files for their loaders', async () => {
    const { paths, convertStoredNames } = await freshRoot()
    writeFileSync(paths.config, '{ not json')
    writeFileSync(paths.layout, JSON.stringify({ formatVersion: 99, archiveBoxesHeight: 300 }))
    await convertStoredNames()
    expect(readFileSync(paths.config, 'utf8')).toBe('{ not json')
    expect(json(paths.layout)).toEqual({ formatVersion: 99, archiveBoxesHeight: 300 })
    expect(readdirSync(paths.root)).not.toContain('collection')
  })
})
