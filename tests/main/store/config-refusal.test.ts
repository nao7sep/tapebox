import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { header } from '../../helpers/file-header'

// Real filesystem (a temp dir) so the read → parse → refuse path is exercised end to end.
// Load the production settings owner against an isolated data root.

let dir: string
let config: typeof import('@main/store/config')
const previousRoot = process.env.TAPEBOX_DATA_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-config-'))
  process.env.TAPEBOX_DATA_DIR = dir
  vi.resetModules()
  config = await import('@main/store/config')
})

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = previousRoot
  vi.resetModules()
  await rm(dir, { recursive: true, force: true })
})

describe('loadSettings refusal', () => {
  it('uses built-ins when the file is missing, leaving nothing behind', async () => {
    expect(await config.loadSettings()).toEqual({ status: 'missing' })
    expect(config.getSettings()).toEqual(defaultSettings())
    expect(await readdir(dir)).toEqual([])
  })

  it('returns the parsed settings for a valid config', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify({ ...header('config'), ...defaultSettings() }))

    expect(await config.loadSettings()).toEqual({ status: 'loaded', settingsKept: false })
    expect(config.getSettings()).toEqual(defaultSettings())
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it.each([
    ['unparseable', '{ not valid json'],
    ['a non-object', JSON.stringify(['not a settings map'])],
    ['without a header', JSON.stringify({ autoplay: false })],
    ['of another kind', JSON.stringify({ ...header('layout'), autoplay: false })],
  ])('refuses a config that is %s, leaving it byte-identical with nothing beside it', async (_label, bytes) => {
    const path = join(dir, 'config.json')
    await writeFile(path, bytes)

    await expect(config.loadSettings()).rejects.toMatchObject({ name: 'RefusedFileError', path, reason: 'unreadable' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it('refuses a newer config the same way', async () => {
    const path = join(dir, 'config.json')
    const bytes = JSON.stringify({ ...header('config', 2), autoplay: false })
    await writeFile(path, bytes)

    await expect(config.loadSettings()).rejects.toMatchObject({ name: 'RefusedFileError', path, reason: 'newer' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readdir(dir)).toEqual(['config.json'])
  })
})
