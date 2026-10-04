import { describe, expect, it } from 'vitest'
import {
  atTop,
  cursorAfter,
  durationSeconds,
  jsonBlock,
  mergeNewestPage,
  nearEnd,
  prettyJson,
  recordKey,
  textBlock,
} from '@renderer/records/record-format'
import type { RecordSummary } from '@shared/records'

const row = (id: number, time: string, title = `row ${id}`, kind: RecordSummary['kind'] = 'log'): RecordSummary => ({
  kind, id, session: 's', time, level: 'info', title, text: null, tapeId: null,
})

const a = row(1, '2026-10-04T08:00:01.000Z')
const b = row(2, '2026-10-04T08:00:02.000Z')
const c = row(3, '2026-10-04T08:00:03.000Z')
const d = row(4, '2026-10-04T08:00:04.000Z')
const keys = (records: RecordSummary[]) => records.map(recordKey)

describe('mergeNewestPage', () => {
  it('puts new records ahead of the rows shown and keeps the pages already read', () => {
    const merged = mergeNewestPage([c, b, a], true, { records: [d, c], more: true })
    expect(keys(merged.records)).toEqual(keys([d, c, b, a]))
    expect(merged.more).toBe(true)
  })

  it("takes the page's word on whether more follow when it reaches past every row shown", () => {
    expect(mergeNewestPage([b], true, { records: [c, b, a], more: false }).more).toBe(false)
  })

  it('loses nothing to an older page that arrives after a newer one', () => {
    const merged = mergeNewestPage([d, c, b, a], true, { records: [c, b], more: true })
    expect(keys(merged.records)).toEqual(keys([d, c, b, a]))
    expect(merged.more).toBe(true)
  })

  it("takes the page's copy of a row it shares with the list", () => {
    const fresh = { ...c, title: 'fresh' }
    expect(mergeNewestPage([c], false, { records: [fresh], more: false }).records[0]!.title).toBe('fresh')
  })

  it('orders records of one instant the way the database pages them', () => {
    const run = row(1, a.time, 'run', 'ytdlp-run')
    const call = row(1, a.time, 'call', 'ai-call')
    expect(keys(mergeNewestPage([], false, { records: [call, a, run], more: false }).records)).toEqual(
      keys([run, a, call]),
    )
  })
})

describe('record format', () => {
  it('keys a record by its kind and id, since ids repeat across tables', () => {
    expect(recordKey({ kind: 'ai-call', id: 3 })).not.toBe(recordKey({ kind: 'log', id: 3 }))
  })

  it('indents stored JSON and shows other text as it is', () => {
    expect(prettyJson('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(prettyJson('not json {')).toBe('not json {')
  })

  it('gives no block for stored JSON that holds nothing', () => {
    for (const empty of ['{}', 'null', '[]', '""', '"  "', '', ' \n']) expect(jsonBlock(empty)).toBeNull()
  })

  it('indents a block of stored JSON with content, and keeps other text as it is', () => {
    expect(jsonBlock('["-i","in.mp4"]')).toBe('[\n  "-i",\n  "in.mp4"\n]')
    expect(jsonBlock('{"a":{}}')).toBe('{\n  "a": {}\n}')
    expect(jsonBlock('not json {')).toBe('not json {')
  })

  it('leaves out of a block the fields the pane already shows, and gives none when nothing remains', () => {
    expect(jsonBlock('{"tapeId":"t1","bytes":5}', { tapeId: 't1' })).toBe('{\n  "bytes": 5\n}')
    expect(jsonBlock('{"tapeId":"t1"}', { tapeId: 't1' })).toBeNull()
    expect(jsonBlock('{"tapeId":"t2"}', { tapeId: 't1' })).toBe('{\n  "tapeId": "t2"\n}')
  })

  it('gives no block for tool output that is only whitespace', () => {
    expect(textBlock('')).toBeNull()
    expect(textBlock(' \n\t')).toBeNull()
    expect(textBlock('  done\n')).toBe('  done\n')
  })

  it('starts the next page after the last record shown', () => {
    expect(cursorAfter([b, a])).toEqual({ time: a.time, kind: 'log', id: 1 })
    expect(cursorAfter([])).toBeNull()
  })

  it('measures a call or run in seconds', () => {
    expect(durationSeconds('2026-10-04T08:00:00.000Z', '2026-10-04T08:00:02.500Z')).toBe(2.5)
  })

  it('counts the list as near its end within a screen of it, and at the top below one pixel', () => {
    expect(nearEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 200 })).toBe(true)
    expect(nearEnd({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 })).toBe(false)
    expect(atTop({ scrollTop: 0.5 })).toBe(true)
    expect(atTop({ scrollTop: 1 })).toBe(false)
  })
})
