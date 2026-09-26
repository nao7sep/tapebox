import { describe, expect, it } from 'vitest'
import { TapeSchema, type Tape } from '@shared/domain'
import { librarySourceIndex } from '@shared/source-identity'

function tape(overrides: Partial<Tape>): Tape {
  return TapeSchema.parse({
    id: 'Tape000001', sourceUrl: 'https://www.youtube.com/watch?v=X', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: null, extractor: null, title: null,
    uploader: null, durationSeconds: null, chapterCount: null, probedAtUtc: null,
    filename: null, sidecarFilename: null, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: null, name: null, renamedAtUtc: null, archivedAtUtc: null, boxId: null,
    order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
    ...overrides,
  })
}

describe('library source identity', () => {
  it('matches the same URL with tracking parameters or a fragment added', () => {
    const index = librarySourceIndex([tape({})])
    expect(index.find({ url: 'https://www.youtube.com/watch?v=X&si=abc#t=3' })).toBe('Tape000001')
    expect(index.has({ url: 'https://www.youtube.com/watch?v=Y' })).toBe(false)
  })

  it('matches a different URL with the same extractor and id, whatever the extractor spelling', () => {
    const index = librarySourceIndex([tape({ extractor: 'youtube', sourceId: 'X' })])
    expect(index.has({ url: 'https://youtu.be/X', extractor: 'Youtube', sourceId: 'X' })).toBe(true)
  })

  it('never matches on a bare id from another or an unknown extractor', () => {
    const index = librarySourceIndex([tape({ extractor: 'youtube', sourceId: 'X' })])
    expect(index.has({ url: 'https://vimeo.com/X', extractor: 'vimeo', sourceId: 'X' })).toBe(false)
    expect(index.has({ url: 'https://example.test/X', extractor: null, sourceId: 'X' })).toBe(false)
  })

  it('leaves out the tape doing the checking', () => {
    const self = tape({ extractor: 'youtube', sourceId: 'X' })
    expect(librarySourceIndex([self], self.id).has({ url: self.sourceUrl, extractor: 'youtube', sourceId: 'X' })).toBe(false)
  })
})
