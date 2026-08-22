import { describe, expect, it } from 'vitest'
import { SessionSchema, TapeSchema } from '@shared/domain'

/** A complete current Tape — every field present, as the app always writes it. */
function completeTape(): Record<string, unknown> {
  return {
    id: 'abc1234567',
    sourceUrl: 'https://example.com/watch?v=x',
    state: 'downloaded',
    addedAtUtc: '2024-01-01T00:00:00.000Z',
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
    archivedAtUtc: null,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
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

  it('strips unknown keys (e.g. a since-removed field) instead of failing', () => {
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
    expect(() => SessionSchema.parse({ tapes: [{ ...tape, boxId: 'missing123' }], boxes: [] })).toThrow(/unknown box id/)
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
})
