import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { unsupportedSelectedPaths } from '@main/core/import-selection'

describe('import selection accounting', () => {
  it('treats sidecar-referenced media and images as successful bundle companions', () => {
    const dir = join('/tmp', 'bundle')
    const selected = [
      join(dir, 'sample.json'),
      join(dir, 'sample.mp4'),
      join(dir, 'poster.png'),
    ]

    expect(unsupportedSelectedPaths(selected, [
      join(dir, 'sample.mp4'),
      join(dir, 'poster.png'),
    ])).toEqual([])
  })

  it('retains unrelated extras while accepting portable companion spellings', () => {
    const dir = join('/tmp', 'bundle')
    expect(unsupportedSelectedPaths([
      join(dir, 'sample.MP4'),
      join(dir, 'notes.txt'),
      join('/tmp', 'elsewhere', 'sample.mp4'),
    ], [join(dir, 'sample.mp4')])).toEqual([
      join(dir, 'notes.txt'),
      join('/tmp', 'elsewhere', 'sample.mp4'),
    ])
  })
})
