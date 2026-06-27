import { describe, it, expect } from 'vitest'

import { planRename } from '@main/core/rename-plan'

describe('planRename', () => {
  it('derives the media/sidecar/thumbnail names and their staging files', () => {
    const plan = planRename(
      { filename: 'old.mp4', sidecarFilename: 'old.json', thumbnailFilename: 'old.webp' },
      'My Tape',
    )
    expect(plan.status).toBe('rename')
    if (plan.status !== 'rename') return
    expect(plan.cleanName).toBe('My Tape')
    expect(plan.newMediaName).toBe('My Tape.mp4')
    expect(plan.newSidecarName).toBe('My Tape.json')
    expect(plan.newThumbName).toBe('My Tape.webp')
    expect(plan.items.map((i) => [i.artifact, i.old, i.fresh, i.stage])).toEqual([
      ['media', 'old.mp4', 'My Tape.mp4', 'My Tape.mp4.staging'],
      ['sidecar', 'old.json', 'My Tape.json', 'My Tape.json.staging'],
      ['thumbnail', 'old.webp', 'My Tape.webp', 'My Tape.webp.staging'],
    ])
  })

  it('is a no-op when the names would not change', () => {
    const plan = planRename(
      { filename: 'clip.mp4', sidecarFilename: 'clip.json', thumbnailFilename: 'clip.jpg' },
      'clip',
    )
    expect(plan.status).toBe('noop')
  })

  it('rejects a name that sanitizes to empty', () => {
    const plan = planRename({ filename: 'a.mp4', sidecarFilename: 'a.json', thumbnailFilename: null }, '...')
    expect(plan.status).toBe('error')
  })

  it('omits the thumbnail item when the tape has no thumbnail', () => {
    const plan = planRename({ filename: 'a.mp4', sidecarFilename: 'a.json', thumbnailFilename: null }, 'b')
    if (plan.status !== 'rename') throw new Error('expected a rename plan')
    expect(plan.items.map((i) => i.artifact)).toEqual(['media', 'sidecar'])
    expect(plan.newThumbName).toBeNull()
  })

  it('rejects a rename where two artifacts would collide on the same target name', () => {
    // The media and thumbnail share an extension, so both derive "<name>.jpg" —
    // a collision the handler's per-file disk checks cannot catch (neither target
    // exists yet). The plan must surface it instead of clobbering one file.
    const plan = planRename(
      { filename: 'a.jpg', sidecarFilename: 'a.json', thumbnailFilename: 'thumb.jpg' },
      'shared',
    )
    expect(plan.status).toBe('error')
    if (plan.status === 'error') expect(plan.message).toMatch(/same name/)
  })
})
