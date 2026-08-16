import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettingsFile } from '../../../src/main/store/config'
import { defaultSettings } from '../../../src/shared/settings'

// End-to-end on a REAL corrupt file: the branch taken, the bytes preserved, and the
// path handed back for the report. Unit tests over the parse alone are what let a
// dead report ship — they pass whether or not the user is ever told.
describe('a corrupt config on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tapebox-corrupt-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('quarantines the bytes verbatim and reports where they went', async () => {
    const path = join(dir, 'config.json')
    const corrupt = '{ this is not valid json'
    writeFileSync(path, corrupt)

    const result = await readSettingsFile(path)

    // The branch: corrupt, not "absent" and not "loaded".
    expect(result).toMatchObject({ quarantinePath: expect.stringContaining('.invalid') })
    const quarantinePath = (result as { quarantinePath: string }).quarantinePath

    // The bytes: preserved exactly, and the original gone from its old name.
    expect(readFileSync(quarantinePath, 'utf8')).toBe(corrupt)
    expect(readdirSync(dir).filter((f) => f === 'config.json')).toEqual([])

    // The report: the path the app edge shows the user actually exists.
    expect(readdirSync(dir).some((f) => quarantinePath.endsWith(f))).toBe(true)
  })

  it('leaves a sound config in place and reports nothing', async () => {
    // A COMPLETE settings object: a partial one is shape-invalid by design, which
    // is itself the corrupt branch (storage-path conventions).
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify(defaultSettings()))
    const result = await readSettingsFile(path)
    expect(result).toHaveProperty('settings')
    expect(readdirSync(dir)).toEqual(['config.json'])
  })

  it('treats an absent file as first run, with nothing to preserve', async () => {
    expect(await readSettingsFile(join(dir, 'config.json'))).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })
})
