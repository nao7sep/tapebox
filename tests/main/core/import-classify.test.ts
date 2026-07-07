import { describe, it, expect } from 'vitest'

import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'

describe('classifyImport', () => {
  it('rejects anything without a string tapebox.sourceUrl', () => {
    expect(classifyImport({}).status).toBe('reject')
    expect(classifyImport({ tapebox: {} }).status).toBe('reject')
    expect(classifyImport({ tapebox: { sourceUrl: 123 } }).status).toBe('reject')
  })

  it('rejects a sidecar that does not name its media file', () => {
    const result = classifyImport({ tapebox: { sourceUrl: 'http://x' } })
    expect(result.status).toBe('reject')
    if (result.status === 'reject') expect(result.reason).toMatch(/name its media file/)
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

  it('coerces typed fields and defaults clock-derived fields to nowUtc', () => {
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
      probedAtUtc: params.nowUtc,
      addedAtUtc: params.nowUtc,
      downloadedAtUtc: params.nowUtc,
    })
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
