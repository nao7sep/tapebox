// End-to-end backup runs over a throwaway TAPEBOX_HOME: a first run captures the durable home-root files
// (config.json, catalog.json) at their mirror paths and NEVER the excluded library/ tree or the excluded
// secrets file (api-keys.json); an unchanged run writes nothing; an edit captures only what changed; a
// corrupt index resets to a full backup; an unreadable subdirectory is skipped without failing the run.
//
// TAPEBOX_HOME is redirected to a scratch dir BEFORE @main/paths is first imported (storageRoot() caches
// on first access), so the modules under test are loaded dynamically after the env is set.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Open } from 'unzipper'

vi.mock('@main/io/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const SAVED_HOME = process.env.TAPEBOX_HOME
const RUN1 = new Date('2026-07-01T00:00:00Z')
const RUN2 = new Date('2026-07-01T01:00:00Z')

let home: string
let runBackup: (typeof import('@main/core/backup/backupEngine'))['runBackup']
let paths: (typeof import('@main/paths'))['paths']

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tapebox-backup-'))
  process.env.TAPEBOX_HOME = home
  vi.resetModules()
  paths = (await import('@main/paths')).paths
  runBackup = (await import('@main/core/backup/backupEngine')).runBackup

  // A realistic home root: the three managed files, plus an excluded library/ tree that must never land
  // in the archive.
  fs.writeFileSync(paths.config, JSON.stringify({ a: 1 }))
  fs.writeFileSync(paths.catalog, JSON.stringify({ boxes: [] }))
  fs.writeFileSync(paths.apiKeys, JSON.stringify({ openai: 'sk-secret' }))
  fs.writeFileSync(paths.layout, JSON.stringify({ w: 800 })) // volatile — must be excluded
  fs.mkdirSync(paths.library, { recursive: true })
  fs.writeFileSync(path.join(paths.library, 'video.mp4'), 'big media bytes')
})

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.TAPEBOX_HOME
  else process.env.TAPEBOX_HOME = SAVED_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

function archiveAbsPath(name: string): string {
  return path.join(paths.backups, name)
}

async function zipEntries(zipFile: string): Promise<string[]> {
  const directory = await Open.file(zipFile)
  return directory.files.map((f) => f.path).sort()
}

describe('runBackup', () => {
  it('captures the durable home-root files and excludes library/ + layout.json + api-keys.json', async () => {
    const report = await runBackup(RUN1)

    expect(report.fatal).toBeUndefined()
    expect(report.nothingChanged).toBe(false)
    expect(report.archiveFileName).toBe('backup-20260701-000000-utc.zip')

    const entries = await zipEntries(archiveAbsPath(report.archiveFileName!))
    expect(entries).toEqual(['catalog.json', 'config.json'])
    // Explicitly assert the excluded trees/files never leaked into the archive.
    expect(entries).not.toContain('layout.json')
    expect(entries).not.toContain('api-keys.json') // secrets are not backed up
    expect(entries.some((e) => e.startsWith('library/'))).toBe(false)

    // The index is the { entries: [...] } OBJECT shape, one entry per file, with the four fields.
    const index = JSON.parse(fs.readFileSync(paths.backupIndex, 'utf8'))
    expect(Array.isArray(index)).toBe(false)
    expect(Array.isArray(index.entries)).toBe(true)
    expect(index.entries).toHaveLength(2)
    expect(Object.keys(index.entries[0])).toEqual([
      'archivedAt',
      'archivePath',
      'sizeBytes',
      'lastWriteUtc',
    ])
    expect(index.entries[0].archivedAt).toBe('20260701-000000-utc')
    expect(index.entries[0].lastWriteUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('writes nothing on a second run with no changes', async () => {
    await runBackup(RUN1)
    const report = await runBackup(RUN2)

    expect(report.nothingChanged).toBe(true)
    expect(fs.existsSync(archiveAbsPath('backup-20260701-010000-utc.zip'))).toBe(false)
  })

  it('captures only the changed file after an edit', async () => {
    await runBackup(RUN1)

    fs.writeFileSync(paths.catalog, JSON.stringify({ boxes: [{ id: 'b1' }] })) // size differs

    const report = await runBackup(RUN2)

    expect(report.filesArchived).toBe(1)
    const entries = await zipEntries(archiveAbsPath('backup-20260701-010000-utc.zip'))
    expect(entries).toEqual(['catalog.json'])
  })

  it('resets a corrupt index to a full backup', async () => {
    await runBackup(RUN1)

    fs.writeFileSync(paths.backupIndex, '{ not valid json')

    const report = await runBackup(RUN2)

    expect(report.indexWasReset).toBe(true)
    expect(report.filesArchived).toBe(2) // config.json + catalog.json
  })

  it('skips an unreadable subdirectory and continues', async () => {
    if (process.platform === 'win32') return // POSIX chmod semantics only

    const locked = path.join(paths.root, 'catalog-data')
    fs.mkdirSync(locked, { recursive: true })
    fs.writeFileSync(path.join(locked, 'inner.json'), '{}')
    fs.chmodSync(locked, 0o000)
    try {
      const report = await runBackup(RUN1)

      expect(report.nothingChanged).toBe(false) // the top-level files are still captured
      expect(report.skips.some((s) => s.path === locked)).toBe(true)
    } finally {
      fs.chmodSync(locked, 0o700) // restore so afterEach cleanup can remove it
    }
  })
})
