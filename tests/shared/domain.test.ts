import { describe, expect, it } from 'vitest'
import { TapeSchema } from '@shared/domain'

/** A tape as written before extractor/thumbnailFilename existed and while the
 *  now-removed remote `thumbnailUrl` was still stored. */
function legacyTape(): Record<string, unknown> {
  return {
    id: 'abc1234567',
    sourceUrl: 'https://example.com/watch?v=x',
    state: 'downloaded',
    addedAtUtc: '2024-01-01T00:00:00.000Z',
    sourceId: 'x',
    title: 'A video',
    uploader: 'Someone',
    durationSeconds: 12,
    chapterCount: 0,
    thumbnailUrl: 'https://cdn.example.com/x.jpg',
    probedAtUtc: '2024-01-01T00:00:00.000Z',
    filename: 'x.mp4',
    sidecarFilename: 'x.json',
    downloadedAtUtc: '2024-01-01T00:00:00.000Z',
    slug: null,
    renamedAtUtc: null,
    archivedAtUtc: null,
    lastError: null,
  }
}

describe('TapeSchema back-compat', () => {
  it('loads a tape written before extractor/thumbnailFilename existed', () => {
    const parsed = TapeSchema.parse(legacyTape())
    expect(parsed.extractor).toBeNull()
    expect(parsed.thumbnailFilename).toBeNull()
  })

  it('drops the removed remote thumbnailUrl field rather than failing to load', () => {
    const parsed = TapeSchema.parse(legacyTape()) as Record<string, unknown>
    expect('thumbnailUrl' in parsed).toBe(false)
  })
})
