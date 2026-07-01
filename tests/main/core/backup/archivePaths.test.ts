// The mirror-layout mapping: TapeBox is home-root-only, so a home file keeps its relative path.

import { describe, it, expect } from 'vitest'
import { forHomeFile, normalize } from '@main/core/backup/archivePaths'

describe('archivePaths', () => {
  it('keeps a home file at its relative path', () => {
    expect(forHomeFile('catalog.json')).toBe('catalog.json')
    expect(forHomeFile('config.json')).toBe('config.json')
    expect(forHomeFile('api-keys.json')).toBe('api-keys.json')
  })

  it('normalizes backslashes and a leading slash', () => {
    expect(normalize('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(normalize('/config.json')).toBe('config.json')
  })
})
