import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSettingsFile } from '@main/store/config'
import { defaultSettings } from '@shared/settings'

// Real filesystem (a temp dir) so the read → parse → quarantine path is exercised end to end.
// readSettingsFile is the path-taking seam loadSettings wraps (mirrors loadSessionFile).

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readSettingsFile', () => {
  it('returns null when the file is missing, leaving nothing behind', async () => {
    expect(await readSettingsFile(join(dir, 'config.json'))).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('returns the parsed settings for a valid config', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify(defaultSettings()))

    expect(await readSettingsFile(path)).toEqual(defaultSettings())
  })

  it('quarantines an unparseable config aside rather than discarding it', async () => {
    const path = join(dir, 'config.json')
    const corrupt = '{ not valid json'
    await writeFile(path, corrupt)

    expect(await readSettingsFile(path)).toBeNull()

    // The corrupt bytes survive as a `config.corrupt-<stamp>.json` neighbour; the original is moved.
    const files = await readdir(dir)
    const quarantined = files.find((f) => f.startsWith('config.corrupt-') && f.endsWith('.json'))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe(corrupt)
    expect(files).not.toContain('config.json')
  })

  it('quarantines a schema-invalid config rather than wiping it', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify({ libraryDir: 42 }))

    expect(await readSettingsFile(path)).toBeNull()

    const quarantined = (await readdir(dir)).find(
      (f) => f.startsWith('config.corrupt-') && f.endsWith('.json'),
    )
    expect(quarantined).toBeDefined()
  })
})
