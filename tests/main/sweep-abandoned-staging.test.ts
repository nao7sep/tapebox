import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// sweepAbandonedStaging clears ~/.tapebox/temp on launch: only managed-tool
// installs stage there, and none can be running yet. It must run against a
// redirected storage root, never the real one — so TAPEBOX_DATA_DIR is pointed at
// a scratch dir BEFORE @main/paths is first imported (its storageRoot() caches on
// first access).
describe('sweepAbandonedStaging', () => {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-reset-'))
  const previous = process.env.TAPEBOX_DATA_DIR
  let paths: (typeof import('@main/paths'))['paths']
  let sweepAbandonedStaging: (typeof import('@main/paths'))['sweepAbandonedStaging']

  beforeAll(async () => {
    process.env.TAPEBOX_DATA_DIR = root
    const mod = await import('@main/paths')
    paths = mod.paths
    sweepAbandonedStaging = mod.sweepAbandonedStaging
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.TAPEBOX_DATA_DIR
    else process.env.TAPEBOX_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })

  it('stays inside the redirected storage root', () => {
    expect(paths.temp).toBe(join(root, 'temp'))
  })

  it('creates temp/ when it does not yet exist', async () => {
    rmSync(paths.temp, { recursive: true, force: true })
    await sweepAbandonedStaging()
    expect(existsSync(paths.temp)).toBe(true)
    expect(readdirSync(paths.temp)).toEqual([])
  })

  it('removes every leftover, whatever its name, and leaves temp/ ready for the next install', async () => {
    mkdirSync(paths.temp, { recursive: true })
    const leftovers = [
      'yt-dlp-abcDEF1234.partial',
      // The earlier host-and-pid naming, from before this launch's version.
      'ffmpeg-deadbeef-99999999-abcDEF12347.partial',
      'notes.txt',
    ]
    for (const name of leftovers) writeFileSync(join(paths.temp, name), 'stale bytes')
    mkdirSync(join(paths.temp, 'extracted'))
    writeFileSync(join(paths.temp, 'extracted', 'ffmpeg'), 'stale bytes')

    await sweepAbandonedStaging()

    expect(readdirSync(paths.temp)).toEqual([])
    writeFileSync(join(paths.temp, 'yt-dlp-next123456.partial'), 'new install')
    expect(readdirSync(paths.temp)).toEqual(['yt-dlp-next123456.partial'])
  })
})
