import { describe, it, expect } from 'vitest'

import { planRename } from '@main/core/rename-plan'
import { inEnglish } from '../../helpers/i18n'

describe('planRename', () => {
  it('derives the media/sidecar/thumbnail names', () => {
    const plan = planRename(
      { name: null, filename: 'old.mp4', sidecarFilename: 'old.json', thumbnailFilename: 'old.webp' },
      'My Tape',
    )
    expect(plan.status).toBe('rename')
    if (plan.status !== 'rename') return
    expect(plan.cleanName).toBe('My Tape')
    expect(plan.newMediaName).toBe('My Tape.mp4')
    expect(plan.newSidecarName).toBe('My Tape.json')
    expect(plan.newThumbName).toBe('My Tape.webp')
    expect(plan.items.map((item) => item.fresh)).toEqual(['My Tape.mp4', 'My Tape.json', 'My Tape.webp'])
  })

  it('is a no-op when the names would not change', () => {
    const plan = planRename(
      { name: null, filename: 'clip.mp4', sidecarFilename: 'clip.json', thumbnailFilename: 'clip.jpg' },
      'clip',
    )
    expect(plan.status).toBe('noop')
  })

  it('is a no-op when a named tape is given its own name again, whatever its files are called', () => {
    // A case-only rename keeps the old spelling on disk, so the files still say
    // "Clip" while the tape is named "clip".
    const plan = planRename(
      { name: 'clip', filename: 'Clip.mp4', sidecarFilename: 'Clip.json', thumbnailFilename: 'Clip.jpg' },
      'clip',
    )
    expect(plan.status).toBe('noop')
  })

  it('renames a named tape to a new spelling even when its files already carry it', () => {
    const plan = planRename(
      { name: 'clip', filename: 'Clip.mp4', sidecarFilename: 'Clip.json', thumbnailFilename: null },
      'Clip',
    )
    expect(plan.status).toBe('rename')
    if (plan.status === 'rename') expect(plan.cleanName).toBe('Clip')
  })

  it('rejects a name that sanitizes to empty', () => {
    const plan = planRename({ name: null, filename: 'a.mp4', sidecarFilename: 'a.json', thumbnailFilename: null }, '...')
    expect(plan.status).toBe('error')
  })

  it('omits the thumbnail item when the tape has no thumbnail', () => {
    const plan = planRename({ name: null, filename: 'a.mp4', sidecarFilename: 'a.json', thumbnailFilename: null }, 'b')
    if (plan.status !== 'rename') throw new Error('expected a rename plan')
    expect(plan.items.map((i) => i.artifact)).toEqual(['media', 'sidecar'])
    expect(plan.newThumbName).toBeNull()
  })

  it('rejects a rename where two artifacts would collide on the same target name', () => {
    // The media and thumbnail share an extension, so both derive "<name>.jpg" —
    // a collision the handler's per-file disk checks cannot catch (neither target
    // exists yet). The plan must surface it instead of clobbering one file.
    const plan = planRename(
      { name: null, filename: 'a.jpg', sidecarFilename: 'a.json', thumbnailFilename: 'thumb.jpg' },
      'shared',
    )
    expect(plan.status).toBe('error')
    if (plan.status === 'error') expect(inEnglish(plan.message)).toMatch(/same name/)
  })
})
