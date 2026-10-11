import { describe, expect, it } from 'vitest'
import { claimManagedFiles, managedFilenameClaimed, nameInStem, tryClaimManagedFiles } from '@main/core/managed-files'

describe('managed filename claim lifetime', () => {
  it('retains portable-equivalent claims until each independent effect settles', () => {
    const first = claimManagedFiles('/library', { names: ['Clip.jpg'] })
    const second = claimManagedFiles('/library/.', { names: ['clip.JPG'] })
    try {
      expect(managedFilenameClaimed('/library', 'CLIP.JPG')).toBe(true)
      first()
      first()
      expect(managedFilenameClaimed('/library', 'clip.jpg')).toBe(true)
    } finally { first(); second() }
    expect(managedFilenameClaimed('/library', 'clip.jpg')).toBe(false)
  })

  it('covers provider extensions and nested fragment stems without excluding unrelated files or folders', () => {
    const release = tryClaimManagedFiles('/library', { stems: ['TapeId'] })!
    try {
      expect(managedFilenameClaimed('/library', 'tapeid.info.json')).toBe(true)
      expect(managedFilenameClaimed('/library', 'TapeId.mp4.part')).toBe(true)
      expect(tryClaimManagedFiles('/library', { stems: ['TapeId.poster-raw'] })).toBeNull()
      expect(tryClaimManagedFiles('/library', { names: ['TapeId.jpg'] })).toBeNull()
      const independent = tryClaimManagedFiles('/library', { names: ['TapeIdish.jpg'] })!
      const external = tryClaimManagedFiles('/exports', { names: ['TapeId.jpg'] })!
      independent()
      external()
      expect(nameInStem('TapeIdish.jpg', 'TapeId')).toBe(false)
    } finally { release() }
    expect(managedFilenameClaimed('/library', 'TapeId.jpg')).toBe(false)
  })
})
