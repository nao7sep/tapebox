import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordsQuery } from '@shared/records'

// The Records window's reads, through the real reader thread over a real
// records database written by io/records.ts.

const prevHome = process.env.TAPEBOX_DATA_DIR
const roots: string[] = []
const closers: Array<() => void> = []

async function freshApp() {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-records-read-'))
  roots.push(root)
  process.env.TAPEBOX_DATA_DIR = root
  vi.resetModules()
  const records = await import('@main/io/records')
  const reader = await import('@main/io/records-read')
  closers.push(reader.closeRecordsReader, records.closeRecords)
  return { records, reader }
}

afterEach(() => {
  vi.useRealTimers()
  for (const close of closers.splice(0)) close()
  if (prevHome === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = prevHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const query = (overrides: Partial<RecordsQuery> = {}): RecordsQuery => ({
  session: null, kind: null, level: null, tapeId: null, search: '', after: null, ...overrides,
})

type Records = Awaited<ReturnType<typeof freshApp>>['records']

function logRow(records: Records, time: string, level: string, message: string, tapeId: string | null = null, fields = '{}') {
  records.writeRecord('logs', { time, level, message, tape_id: tapeId, fields }, () => message)
}

function seed(records: Records): void {
  logRow(records, '2026-10-04T10:00:01.000Z', 'info', 'job start', 't1', JSON.stringify({ tapeId: 't1', url: 'https://example.com/v' }))
  logRow(records, '2026-10-04T10:00:02.000Z', 'warn', 'download stalled', 't1')
  records.writeRecord('ai_calls', {
    tape_id: 't1', started_at_utc: '2026-10-04T10:00:03.000Z', ended_at_utc: '2026-10-04T10:00:04.250Z',
    endpoint: 'https://api.openai.com/v1', model: 'gpt-x', request: JSON.stringify({ input: 'slug 100%' }),
    status: 429, response: JSON.stringify({ message: 'quota' }), error: JSON.stringify({ name: 'RateLimitError' }),
  }, () => 'ai call')
  records.writeRecord('ytdlp_runs', {
    tape_id: null, scan_id: 's1', kind: 'scan', url: 'https://example.com/list', args: JSON.stringify(['--flat-playlist']),
    started_at_utc: '2026-10-04T10:00:05.000Z', ended_at_utc: '2026-10-04T10:00:06.000Z', exit_code: 0, signal: null,
    stdout: 'found 3 entries', stderr: '',
  }, () => 'yt-dlp run')
  records.writeRecord('ffmpeg_runs', {
    tape_id: 't2', kind: 'thumbnail', args: JSON.stringify(['-i', 'in.webp']),
    started_at_utc: '2026-10-04T10:00:07.000Z', ended_at_utc: '2026-10-04T10:00:07.500Z', exit_code: 1, signal: null,
    stdout: '', stderr: 'Invalid data found',
  }, () => 'ffmpeg run')
}

describe('records reads', () => {
  it('pages every kind newest first, a failed call or run reading as an error', async () => {
    const { records, reader } = await freshApp()
    const session = records.openRecords()
    seed(records)

    const page = await reader.readRecords({ op: 'page', query: query() })
    expect(page.more).toBe(false)
    expect(page.records.map((record) => [record.kind, record.level, record.title, record.text])).toEqual([
      ['ffmpeg-run', 'error', 'ffmpeg thumbnail', null],
      ['ytdlp-run', 'info', 'yt-dlp scan', 'https://example.com/list'],
      ['ai-call', 'error', 'gpt-x', 'https://api.openai.com/v1'],
      ['log', 'warn', 'download stalled', null],
      ['log', 'info', 'job start', null],
    ])
    expect(page.records[0]).toMatchObject({ session, tapeId: 't2', time: '2026-10-04T10:00:07.000Z' })
  })

  it('filters by kind, level, tape and launch, and searches every stored field literally', async () => {
    const { records, reader } = await freshApp()
    const session = records.openRecords()
    seed(records)
    const titles = async (overrides: Partial<RecordsQuery>) =>
      (await reader.readRecords({ op: 'page', query: query(overrides) })).records.map((record) => record.title)

    expect(await titles({ kind: 'log' })).toEqual(['download stalled', 'job start'])
    expect(await titles({ level: 'attention' })).toEqual(['ffmpeg thumbnail', 'gpt-x', 'download stalled'])
    expect(await titles({ level: 'info' })).toEqual(['yt-dlp scan', 'job start'])
    expect(await titles({ tapeId: 't1' })).toEqual(['gpt-x', 'download stalled', 'job start'])
    expect(await titles({ session: 'another launch' })).toEqual([])
    expect(await titles({ session })).toHaveLength(5)
    // Search reaches a request, a run's output and a log line's fields, and takes % literally.
    expect(await titles({ search: '100%' })).toEqual(['gpt-x'])
    expect(await titles({ search: '10%' })).toEqual([])
    expect(await titles({ search: 'Invalid data' })).toEqual(['ffmpeg thumbnail'])
    expect(await titles({ search: 'example.com/v' })).toEqual(['job start'])
    expect(await titles({ search: '  ' })).toHaveLength(5)
  })

  it('continues a long list from the last record of the page before', async () => {
    const { records, reader } = await freshApp()
    records.openRecords()
    for (let index = 0; index < 150; index++) {
      // Two lines share each instant, so the cursor's tie-break is exercised.
      logRow(records, `2026-10-04T10:00:${String(Math.floor(index / 2)).padStart(2, '0')}.000Z`, 'info', `line ${index}`)
    }

    const first = await reader.readRecords({ op: 'page', query: query() })
    expect(first.records).toHaveLength(100)
    expect(first.more).toBe(true)
    const last = first.records.at(-1)!
    const second = await reader.readRecords({
      op: 'page',
      query: query({ after: { time: last.time, kind: last.kind, id: last.id } }),
    })
    expect(second.records).toHaveLength(50)
    expect(second.more).toBe(false)
    const ids = [...first.records, ...second.records].map((record) => record.id)
    expect(new Set(ids).size).toBe(150)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })

  it('reads each kind whole, every field as stored', async () => {
    const { records, reader } = await freshApp()
    const session = records.openRecords()
    seed(records)
    const page = await reader.readRecords({ op: 'page', query: query() })
    const idOf = (kind: string) => page.records.find((record) => record.kind === kind)!.id

    expect(await reader.readRecords({ op: 'detail', kind: 'ai-call', id: idOf('ai-call') })).toEqual({
      kind: 'ai-call', id: idOf('ai-call'), session, tapeId: 't1',
      startedAt: '2026-10-04T10:00:03.000Z', endedAt: '2026-10-04T10:00:04.250Z',
      endpoint: 'https://api.openai.com/v1', model: 'gpt-x', request: JSON.stringify({ input: 'slug 100%' }),
      status: 429, response: JSON.stringify({ message: 'quota' }), error: JSON.stringify({ name: 'RateLimitError' }),
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'ytdlp-run', id: idOf('ytdlp-run') })).toMatchObject({
      kind: 'ytdlp-run', run: 'scan', scanId: 's1', url: 'https://example.com/list', exitCode: 0, signal: null,
      args: JSON.stringify(['--flat-playlist']), stdout: 'found 3 entries', stderr: '',
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'ffmpeg-run', id: idOf('ffmpeg-run') })).toMatchObject({
      kind: 'ffmpeg-run', run: 'thumbnail', tapeId: 't2', exitCode: 1, stderr: 'Invalid data found',
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'log', id: idOf('log') })).toMatchObject({
      kind: 'log', level: 'warn', message: 'download stalled', tapeId: 't1', fields: '{}',
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'log', id: 999 })).toBeNull()
  })

  it('lists every launch and every tape that has records, latest first', async () => {
    const { records, reader } = await freshApp()
    const session = records.openRecords()
    seed(records)

    expect(await reader.readRecords({ op: 'sources' })).toEqual({ sessions: [session], tapeIds: ['t2', 't1'] })
  })

  it('fails a read the database cannot answer, and reads again afterwards', async () => {
    const { records, reader } = await freshApp()
    // No database has been opened yet, so the read-only reader finds no file.
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow()

    const session = records.openRecords()
    seed(records)
    expect((await reader.readRecords({ op: 'sources' })).sessions).toEqual([session])
  })

  it('gives up on a read that does not answer in time, and starts a fresh reader for the next', async () => {
    const { records, reader } = await freshApp()
    records.openRecords()
    seed(records)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const stuck = reader.readRecords({ op: 'sources' })
    vi.advanceTimersByTime(reader.READ_TIMEOUT_MS)
    await expect(stuck).rejects.toThrow(/did not answer/)

    vi.useRealTimers()
    expect((await reader.readRecords({ op: 'sources' })).tapeIds).toEqual(['t2', 't1'])
  })
})
