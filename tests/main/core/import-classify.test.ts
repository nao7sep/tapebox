import { describe, it, expect } from 'vitest'

import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { inEnglish } from '../../helpers/i18n'

describe('classifyImport', () => {
  it.each([
    { title: 7 }, { id: [] }, { uploader: {} }, { extractor: false },
    { duration: -1 }, { duration: Number.POSITIVE_INFINITY }, { chapters: 'wrong' },
  ])('rejects malformed present consumed fields before any bundle copy: %j', (fields) => {
    expect(classifyImport({ formatVersion: 1, ...fields, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'v.mp4' } }))
      .toMatchObject({ status: 'reject', reason: { key: 'import.sidecarInvalidJson' } })
  })

  it.each([
    { addedAtUtc: 'yesterday' }, { downloadedAtUtc: '2026-02-30T00:00:00.000Z' },
    { renamedAtUtc: 9 }, { name: [] },
    { addedAtUtc: '2026-01-01T00:00:00.12345678Z' },
    { addedAtUtc: '2026-01-01T00:00:00+01:00' }, { addedAtUtc: '2026-01-01T00:00:00' },
  ])('rejects malformed present TapeBox catalog fields: %j', (fields) => {
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'v.mp4', ...fields } }))
      .toMatchObject({ status: 'reject', reason: { key: 'import.sidecarInvalidJson' } })
  })

  it('accepts absent or null optional fields and leaves unknown yt-dlp data alone', () => {
    expect(classifyImport({
      formatVersion: 1, title: null, duration: null, chapters: null, futureExtractorData: { arbitrary: true },
      tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'v.mp4', downloadedAtUtc: null, name: null },
    }).status).toBe('accept')
  })

  it.each(['2026-01-01T00:00:00Z', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00.1234567Z', '2026-01-01T00:00:00.1234567+00:00'])
    ('accepts recorded UTC spelling %s', (addedAtUtc) => {
      expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'v.mp4', addedAtUtc } }).status).toBe('accept')
    })
  it('rejects anything without a string tapebox.sourceUrl', () => {
    expect(classifyImport({ formatVersion: 1 }).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: {} }).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 123 } }).status).toBe('reject')
    expect(classifyImport(null).status).toBe('reject')
    expect(classifyImport([]).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'file:///etc/passwd', mediaFilename: 'v.mp4' } }).status).toBe('reject')
  })

  it('rejects a sidecar that does not name its media file', () => {
    const result = classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'http://x' } })
    expect(result.status).toBe('reject')
    if (result.status === 'reject') expect(inEnglish(result.reason)).toMatch(/name its media file/)
  })

  it('accepts and pulls out source url, media, and optional thumbnail', () => {
    expect(
      classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'http://x', mediaFilename: 'v.mp4', thumbnailFilename: 'v.webp' } }),
    ).toEqual({ status: 'accept', sourceUrl: 'http://x', mediaFilename: 'v.mp4', thumbnailFilename: 'v.webp' })

    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'http://x', mediaFilename: 'v.mp4' } })).toMatchObject({
      status: 'accept',
      thumbnailFilename: null,
    })
  })

  it('rejects a sidecar without its format marker as not TapeBox JSON', () => {
    expect(classifyImport({ tapebox: { sourceUrl: 'http://x', mediaFilename: 'v.mp4' } })).toMatchObject({
      status: 'reject',
      reason: { key: 'import.sidecarInvalidJson' },
    })
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
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: '../../escape.mp4' } }).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'clip.mp4', thumbnailFilename: '../escape.jpg' } }).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'clip.json' } }).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'clip.mp4', thumbnailFilename: 'CLIP.MP4' } }).status).toBe('reject')
    expect(classifyImport({ formatVersion: 1, tapebox: { sourceUrl: 'https://x.test', mediaFilename: 'Caf\u00e9.mp4', thumbnailFilename: 'Cafe\u0301.MP4' } }).status).toBe('reject')
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

  it('preserves recorded TapeBox timestamps instead of fabricating import event times', () => {
    const tape = tapeFromSidecar(
      {
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

  it('refuses malformed present fields when used directly too', () => {
    expect(() => tapeFromSidecar({ title: 9, tapebox: {} }, params)).toThrow('invalid catalog fields')
  })

  it('emits canonical millisecond UTC after accepting cross-language recorded times', () => {
    const tape = tapeFromSidecar({ tapebox: {
      addedAtUtc: '2026-01-01T00:00:00+00:00', downloadedAtUtc: '2026-01-01T00:00:00.1234567Z',
    } }, params)
    expect(tape.addedAtUtc).toBe('2026-01-01T00:00:00.000Z')
    expect(tape.downloadedAtUtc).toBe('2026-01-01T00:00:00.123Z')
  })
})
