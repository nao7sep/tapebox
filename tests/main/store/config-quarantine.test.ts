import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'

// Real filesystem (a temp dir) so the read → parse → quarantine path is exercised end to end.
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

describe('loadSettings recovery', () => {
  it('uses built-ins when the file is missing, leaving nothing behind', async () => {
    expect(await config.loadSettings()).toEqual({ status: 'missing' })
    expect(config.getSettings()).toEqual(defaultSettings())
    expect(await readdir(dir)).toEqual([])
  })

  it('returns the parsed settings for a valid config', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify({ formatVersion: 1, ...defaultSettings() }))

    expect(await config.loadSettings()).toEqual({ status: 'loaded', settingsKept: false })
    expect(config.getSettings()).toEqual(defaultSettings())
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it('quarantines an unparseable config aside rather than discarding it', async () => {
    const path = join(dir, 'config.json')
    const corrupt = '{ not valid json'
    await writeFile(path, corrupt)

    const result = await config.loadSettings()
    expect(result).toMatchObject({ status: 'recovered', quarantinePath: expect.stringContaining('.invalid') })
    expect(config.getSettings()).toEqual(defaultSettings())

    // The corrupt bytes survive as a `config-<yyyymmdd-hhmmss-fff-utc>.invalid` neighbour; the original
    // is moved.
    const files = await readdir(dir)
    const quarantined = files.find((f) => f.startsWith('config-') && f.endsWith('.invalid'))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe(corrupt)
    expect(files).not.toContain('config.json')
    if (result.status === 'recovered') expect(await readFile(result.quarantinePath, 'utf8')).toBe(corrupt)
  })

  it('quarantines a non-object config rather than wiping it', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify(['not a settings map']))

    const result = await config.loadSettings()
    expect(result).toMatchObject({ status: 'recovered', quarantinePath: expect.stringContaining('.invalid') })
    expect(config.getSettings()).toEqual(defaultSettings())

    const quarantined = (await readdir(dir)).find(
      (f) => f.startsWith('config-') && f.endsWith('.invalid'),
    )
    expect(quarantined).toBeDefined()
  })
})
