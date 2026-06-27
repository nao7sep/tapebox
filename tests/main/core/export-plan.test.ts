import { describe, it, expect } from 'vitest'

import { planExport } from '@main/core/export-plan'

describe('planExport', () => {
  it('computes the destination names from an absolute destination', () => {
    expect(planExport({ filename: 'a.mp4', thumbnailFilename: 'a.webp' }, '/out', 'My Tape')).toEqual({
      status: 'ok',
      cleanName: 'My Tape',
      mediaName: 'My Tape.mp4',
      sidecarName: 'My Tape.json',
      thumbName: 'My Tape.webp',
    })
  })

  it('omits the thumbnail name when the tape has none', () => {
    const plan = planExport({ filename: 'a.mp4', thumbnailFilename: null }, '/out', 'b')
    expect(plan).toMatchObject({ status: 'ok', thumbName: null })
  })

  it('rejects an empty name', () => {
    expect(planExport({ filename: 'a.mp4', thumbnailFilename: null }, '/out', '...').status).toBe('error')
  })

  it('rejects a non-absolute destination directory', () => {
    const plan = planExport({ filename: 'a.mp4', thumbnailFilename: null }, 'relative/dir', 'b')
    expect(plan.status).toBe('error')
    if (plan.status === 'error') expect(plan.message).toMatch(/absolute/)
  })

  it('rejects a collision when media and thumbnail share an extension', () => {
    const plan = planExport({ filename: 'a.jpg', thumbnailFilename: 'thumb.jpg' }, '/out', 'shared')
    expect(plan.status).toBe('error')
    if (plan.status === 'error') expect(plan.message).toMatch(/same name/)
  })
})
