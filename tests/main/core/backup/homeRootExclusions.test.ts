// The home-root exclude list: durable data (config, catalog, api-keys) is kept; logs/, backups/, the
// re-fetchable library/ + bin/ trees, disposable temp/, volatile layout.json, atomic-write temporaries,
// and the case-insensitive OS-noise floor are dropped.

import { describe, it, expect } from 'vitest'
import { isExcludedFile, isExcludedDir } from '@main/core/backup/homeRootExclusions'

describe('isExcludedFile', () => {
  it.each(['config.json', 'catalog.json', 'api-keys.json', 'some/durable.json'])(
    'includes %s',
    (relativePath) => {
      expect(isExcludedFile(relativePath)).toBe(false)
    },
  )

  it.each([
    'logs/20260701-000000-utc.log',
    'backups/index.json',
    'backups/backup-20260701-000000-utc.zip',
    'library/abc/video.mp4',
    'bin/yt-dlp',
    'temp/download.part',
    'layout.json',
    '.config.json.1234.tmp',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    'Desktop.ini', // OS-noise floor, matched case-insensitively
    'catalog/DESKTOP.INI', // case-insensitive floor at depth
  ])('excludes %s', (relativePath) => {
    expect(isExcludedFile(relativePath)).toBe(true)
  })
})

describe('isExcludedDir', () => {
  it('prunes the top-level logs, backups, library, bin, and temp directories', () => {
    for (const dir of ['logs', 'backups', 'library', 'bin', 'temp']) {
      expect(isExcludedDir(dir)).toBe(true)
    }
  })

  it('does not prune an unrelated directory', () => {
    expect(isExcludedDir('catalog')).toBe(false)
  })
})
