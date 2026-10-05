import { describe, it, expect } from 'vitest'

import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { inEnglish } from '../../helpers/i18n'

describe('classifyImport', () => {
  it('rejects anything without a string tapebox.sourceUrl', () => {
    expect(classifyImport({}).status).toBe('reject')
    expect(classifyImport({ tapebox: {} }).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 123 } }).status).toBe('reject')
    expect(classifyImport(null).status).toBe('reject')
    expect(classifyImport([]).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 'file:///etc/passwd', mediaFilename: 'v.mp4' } }).status).toBe('reject')
  })

  it('rejects a sidecar that does not name its media file', () => {
    const result = classifyImport({ tapebox: { sourceUrl: 'http://x' } })
    expect(result.status).toBe('reject')
    if (result.status === 'reject') expect(inEnglish(result.reason)).toMatch(/name its media file/)
  })

  it('accepts and pulls out source url, media, and optional thumbnail', () => {
    expect(
      classifyImport({ tapebox: { sourceUrl: 'http://x', mediaFilename: 'v.mp4', thumbnailFilename: 'v.webp' } }),
    ).toEqual({ status: 'accept', sourceUrl: 'http://x', mediaFilename: 'v.mp4', thumbnailFilename: 'v.webp' })

    expect(classifyImport({ tapebox: { sourceUrl: 'http://x', mediaFilename: 'v.mp4' } })).toMatchObject({
      status: 'accept',
      thumbnailFilename: null,
    })
  })

  it('reads a sidecar with no format marker, or format 1, as this build\'s own', () => {
    const tapebox = { sourceUrl: 'http://x', mediaFilename: 'v.mp4' }
    expect(classifyImport({ tapebox }).status).toBe('accept')
    expect(classifyImport({ formatVersion: 1, tapebox }).status).toBe('accept')
  })

  it('rejects a sidecar in a newer format, saying so, and one whose marker is not a version', () => {
    const tapebox = { sourceUrl: 'http://x', mediaFilename: 'v.mp4' }
    const newer = classifyImport({ formatVersion: 2, tapebox })
    expect(newer).toMatchObject({ status: 'reject', reason: { key: 'import.sidecarNewer' } })
    if (newer.status === 'reject') expect(inEnglish(newer.reason)).toMatch(/newer version of TapeBox/)
    expect(classifyImport({ formatVersion: 'one', tapebox })).toMatchObject({
      status: 'reject',
      reason: { key: 'import.sidecarInvalidJson' },
    })
  })

  it('rejects path-bearing and colliding bundle filenames before filesystem use', () => {
    expect(classifyImport({ tapebox: { sourceUrl: 'https://x.test', mediaFilename: '../../escape.mp4' } }).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'clip.mp4', thumbnailFilename: '../escape.jpg' } }).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'clip.json' } }).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'clip.mp4', thumbnailFilename: 'CLIP.MP4' } }).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'Caf\u00e9.mp4', thumbnailFilename: 'Cafe\u0301.MP4' } }).status).toBe('reject')
  })
})

describe('tapeFromSidecar', () => {
  const params = {
    id: 'id1',
    sourceUrl: 'http://x',
    mediaFilename: 'v.mp4',
    sidecarFilename: 'v.json',
    thumbnailFilename: 'v.webp',
    order: 5,
    nowUtc: '2026-01-01T00:00:00.000Z',
  }

  it('coerces typed fields and leaves the times the sidecar does not record empty', () => {
    const tape = tapeFromSidecar(
      { id: 'src', extractor: 'youtube', title: 'T', uploader: 'U', duration: 12.5, chapters: [{}, {}], tapebox: {} },
      params,
    )
    expect(tape).toMatchObject({
      id: 'id1',
      sourceUrl: 'http://x',
      state: 'downloaded',
      sourceId: 'src',
      extractor: 'youtube',
      title: 'T',
      uploader: 'U',
      durationSeconds: 12.5,
      chapterCount: 2,
      filename: 'v.mp4',
      sidecarFilename: 'v.json',
      thumbnailFilename: 'v.webp',
      order: 5,
      probedAtUtc: null,
      addedAtUtc: params.nowUtc,
      downloadedAtUtc: null,
    })
  })

  it('takes a missing added time from the recorded download time before the import time', () => {
    const tape = tapeFromSidecar({ tapebox: { downloadedAtUtc: '2025-06-01T00:00:00.000Z' } }, params)
    expect(tape.addedAtUtc).toBe('2025-06-01T00:00:00.000Z')
    expect(tape.downloadedAtUtc).toBe('2025-06-01T00:00:00.000Z')
    expect(tape.probedAtUtc, 'an import never probes').toBeNull()
  })

  it('nulls mistyped fields and prefers the tapebox timestamps when present', () => {
    const tape = tapeFromSidecar(
      {
        id: 42,
        duration: 'nope',
        chapters: 'nope',
        tapebox: {
          addedAtUtc: '2025-12-31T00:00:00.000Z',
          name: 'Nice',
          renamedAtUtc: '2026-02-02T00:00:00.000Z',
          downloadedAtUtc: '2026-03-03T00:00:00.000Z',
        },
      },
      params,
    )
    expect(tape.sourceId).toBeNull()
    expect(tape.durationSeconds).toBeNull()
    expect(tape.chapterCount).toBe(0)
    expect(tape.addedAtUtc).toBe('2025-12-31T00:00:00.000Z')
    expect(tape.name).toBe('Nice')
    expect(tape.renamedAtUtc).toBe('2026-02-02T00:00:00.000Z')
    expect(tape.downloadedAtUtc).toBe('2026-03-03T00:00:00.000Z')
  })
})
