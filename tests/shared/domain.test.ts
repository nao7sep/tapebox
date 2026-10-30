import { describe, expect, it } from 'vitest'
import { SessionSchema, TapeFileSchema, TapeSchema } from '@shared/domain'

/** A complete current Tape — every field present, as the app always writes it. */
function completeTape(): Record<string, unknown> {
  return {
    id: 'abc1234567',
    sourceUrl: 'https://example.com/watch?v=x',
    state: 'downloaded',
    addedAtUtc: '2024-01-01T00:00:00.000Z',
    addedIndex: 0,
    sourceId: 'x',
    extractor: 'example',
    title: 'A video',
    uploader: 'Someone',
    durationSeconds: 12,
    chapterCount: 0,
    probedAtUtc: '2024-01-01T00:00:00.000Z',
    filename: 'x.mp4',
    sidecarFilename: 'x.json',
    thumbnailFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: '2024-01-01T00:00:00.000Z',
    name: null,
    renamedAtUtc: null,
    shelved: false,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    failureCode: null,
    lastError: null,
  }
}

describe('TapeSchema', () => {
  it('parses a complete tape', () => {
    expect(TapeSchema.parse(completeTape()).id).toBe('abc1234567')
  })

  // Pre-release the schema carries NO migration defaults: an incomplete or outdated
  // session is rejected (and quarantined by the caller) rather than half-loaded with
  // guessed values. This guards against silently re-introducing a back-compat default.
  it('is authoritative — rejects a tape missing a field rather than defaulting it', () => {
    const missingOrder = completeTape()
    delete missingOrder.order
    expect(() => TapeSchema.parse(missingOrder)).toThrow()
  })

  it('strips unknown keys instead of failing', () => {
    const parsed = TapeSchema.parse({ ...completeTape(), thumbnailUrl: 'https://cdn/x.jpg' }) as Record<string, unknown>
    expect('thumbnailUrl' in parsed).toBe(false)
  })

  it('rejects non-web sources and path-bearing tracked filenames', () => {
    expect(() => TapeSchema.parse({ ...completeTape(), sourceUrl: 'file:///etc/passwd' })).toThrow()
    expect(() => TapeSchema.parse({ ...completeTape(), filename: '../escape.mp4' })).toThrow()
    expect(() => TapeSchema.parse({ ...completeTape(), sidecarFilename: 'dir\\escape.json' })).toThrow()
  })
})

describe('SessionSchema identities', () => {
  it('rejects duplicate tape and box ids plus dangling box membership', () => {
    const tape = completeTape()
    const box = { id: 'box1234567', name: 'Box', order: 0 }
    expect(() => SessionSchema.parse({ tapes: [tape, { ...tape }], boxes: [] })).toThrow(/duplicate tape id/)
    expect(() => SessionSchema.parse({ tapes: [], boxes: [box, { ...box }] })).toThrow(/duplicate box id/)
    expect(() => SessionSchema.parse({ tapes: [{ ...tape, shelved: true, boxId: 'missing123' }], boxes: [] })).toThrow(/unknown box id/)
    // The Inbox has no boxes, so an Inbox tape naming even a real box is dangling.
    expect(() => SessionSchema.parse({ tapes: [{ ...tape, boxId: box.id }], boxes: [box] })).toThrow(/unknown box id/)
    expect(() => SessionSchema.parse({ tapes: [{ ...tape, shelved: true, boxId: box.id }], boxes: [box] })).not.toThrow()
    expect(() => SessionSchema.parse({ tapes: [], boxes: [box, { ...box, id: 'box7654321', name: ' box ' }] })).toThrow(/box names/)
  })

  it('treats canonically equivalent box names as one durable identity', () => {
    expect(() => SessionSchema.parse({
      tapes: [],
      boxes: [
        { id: 'box1234567', name: 'Caf\u00e9', order: 0 },
        { id: 'box7654321', name: 'Cafe\u0301', order: 1 },
      ],
    })).toThrow(/box names/)
  })

  it('lets two tapes, each in its own folder, use the same file names', () => {
    expect(() => SessionSchema.parse({
      tapes: [
        { ...completeTape(), filename: 'Archive.MP4' },
        { ...completeTape(), id: 'def7654321', sourceUrl: 'https://example.com/watch?v=y', filename: 'archive.mp4' },
      ],
      boxes: [],
    })).not.toThrow()
  })

  it('rejects tape ids that would share a folder on a case-insensitive drive', () => {
    expect(() => SessionSchema.parse({
      tapes: [
        { ...completeTape(), id: 'abcdefghij' },
        { ...completeTape(), id: 'ABCDEFGHIJ', sourceUrl: 'https://example.com/watch?v=y' },
      ],
      boxes: [],
    })).toThrow(/duplicate tape id/)
  })
})

describe('TapeFileSchema', () => {
  /** A tape's own file holds its facts, not where it sits. */
  function tapeFile(): Record<string, unknown> {
    const { shelved: _shelved, boxId: _boxId, order: _order, ...facts } = completeTape()
    return facts
  }

  it('parses a tape file holding only facts', () => {
    expect(TapeFileSchema.parse(tapeFile()).id).toBe('abc1234567')
  })

  it('rejects portable filename aliases within one persisted tape bundle', () => {
    expect(() => TapeFileSchema.parse({
      ...tapeFile(),
      filename: 'Caf\u00e9.MP4',
      thumbnailFilename: 'Cafe\u0301.mp4',
    })).toThrow(/a tape's files must be unique by portable identity/)
  })

  it('rejects a tracked file that would be the tape file itself', () => {
    expect(() => TapeFileSchema.parse({ ...tapeFile(), sidecarFilename: 'Tape.JSON' }))
      .toThrow(/conflicts with tape.json/)
  })
})
