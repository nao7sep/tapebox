// The home-root exclude list: durable data (config, catalog) is kept; the secrets file (api-keys.json),
// logs/, backups/, the re-fetchable library/ + bin/ trees, disposable temp/, volatile layout.json,
// atomic-write temporaries, quarantined-corrupt `.invalid` files, and the case-insensitive OS-noise
// floor are dropped.

import { describe, it, expect } from 'vitest'
import { isExcludedFile, isExcludedDir } from '@main/core/backup/homeRootExclusions'

describe('isExcludedFile', () => {
  it.each(['config.json', 'catalog.json', 'some/durable.json'])(
    'includes %s',
    (relativePath) => {
      expect(isExcludedFile(relativePath)).toBe(false)
    },
  )

  it.each([
    'logs/20260701-000000-123-utc.log',
    'backups/index.json',
    'backups/backup-20260701-000000-123-utc.zip',
    'library/abc/video.mp4',
    'bin/yt-dlp',
    'temp/download.part',
    'layout.json',
    'api-keys.json', // secrets are not backed up
    'config-abc123.tmp',
    'config-20260701-000000-123-utc.invalid', // quarantined-corrupt config
    'catalog-20260701-000000-123-utc.invalid', // quarantined-corrupt catalog
    'api-keys-20260701-000000-123-utc.invalid', // quarantined-corrupt secrets store
    'API-KEYS-20260701-000000-123-UTC.INVALID', // .invalid matched case-insensitively
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
