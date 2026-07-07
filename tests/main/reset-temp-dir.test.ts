import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// resetTempDir wipes ~/.tapebox/temp on launch. It must run against a redirected
// storage root, never the real one — so TAPEBOX_HOME is pointed at a scratch dir
// BEFORE @main/paths is first imported (its storageRoot() caches on first access).
describe('resetTempDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-reset-'))
  const previous = process.env.TAPEBOX_HOME
  let paths: (typeof import('@main/paths'))['paths']
  let resetTempDir: (typeof import('@main/paths'))['resetTempDir']

  beforeAll(async () => {
    process.env.TAPEBOX_HOME = root
    const mod = await import('@main/paths')
    paths = mod.paths
    resetTempDir = mod.resetTempDir
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.TAPEBOX_HOME
    else process.env.TAPEBOX_HOME = previous
    rmSync(root, { recursive: true, force: true })
  })

  it('stays inside the redirected storage root', () => {
    expect(paths.temp).toBe(join(root, 'temp'))
  })

  it('wipes a crash-orphaned partial and leaves temp/ present and empty', async () => {
    mkdirSync(paths.temp, { recursive: true })
    writeFileSync(join(paths.temp, 'yt-dlp-123.partial'), 'stale bytes')

    await resetTempDir()

    expect(existsSync(paths.temp)).toBe(true)
    expect(readdirSync(paths.temp)).toEqual([])
  })
})
