import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

  it('reads a run the user cancelled or TapeBox quit during as a warning, and any other early end as an error', async () => {
    const { records, reader } = await freshApp()
    records.openRecords()
    const run = (second: number, kind: string, exitCode: number | null, signal: string | null, stopReason: string | null) =>
      records.writeRecord('ytdlp_runs', {
        tape_id: 't1', scan_id: null, kind, url: 'https://example.com/v', args: '[]',
        started_at_utc: `2026-10-04T10:00:0${second}.000Z`, ended_at_utc: `2026-10-04T10:00:0${second}.500Z`,
        exit_code: exitCode, signal, stop_reason: stopReason, stdout: '', stderr: '',
      }, () => 'yt-dlp run')
    run(1, 'download', null, 'SIGTERM', 'cancel')
    run(2, 'probe', null, 'SIGTERM', 'quit')
    run(3, 'probe', null, 'SIGTERM', 'idle')
    run(4, 'download', null, 'SIGKILL', null)
    run(5, 'download', 1, null, null)
    run(6, 'download', 0, null, null)
    records.writeRecord('ffmpeg_runs', {
      tape_id: 't1', kind: 'thumbnail', args: '[]', started_at_utc: '2026-10-04T10:00:07.000Z',
      ended_at_utc: '2026-10-04T10:00:07.500Z', exit_code: null, signal: 'SIGTERM', stop_reason: 'cancel', stdout: '', stderr: '',
    }, () => 'ffmpeg run')

    const page = await reader.readRecords({ op: 'page', query: query() })
    expect(page.records.map((record) => [record.title, record.level])).toEqual([
      ['ffmpeg thumbnail', 'warn'],
      ['yt-dlp download', 'info'],
      ['yt-dlp download', 'error'],
      ['yt-dlp download', 'error'],
      ['yt-dlp probe', 'error'],
      ['yt-dlp probe', 'warn'],
      ['yt-dlp download', 'warn'],
    ])
    const levels = async (level: RecordsQuery['level']) =>
      (await reader.readRecords({ op: 'page', query: query({ level }) })).records.map((record) => record.time.slice(17, 19))
    expect(await levels('warn')).toEqual(['07', '02', '01'])
    expect(await levels('error')).toEqual(['05', '04', '03'])
    expect(await levels('attention')).toEqual(['07', '05', '04', '03', '02', '01'])

    const cancelled = page.records.at(-1)!
    expect(await reader.readRecords({ op: 'detail', kind: 'ytdlp-run', id: cancelled.id })).toMatchObject({
      level: 'warn', exitCode: null, signal: 'SIGTERM', stopReason: 'cancel',
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'ffmpeg-run', id: page.records[0]!.id })).toMatchObject({
      level: 'warn', stopReason: 'cancel',
    })
  })

  it('stamps format 1 on a database it creates, and reads it back', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    records.openRecords()
    logRow(records, '2026-10-04T10:00:01.000Z', 'info', 'kept')
    records.closeRecords()
    const check = new DatabaseSync(paths.records, { readOnly: true })
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    check.close()

    records.openRecords()
    const page = await reader.readRecords({ op: 'page', query: query() })
    expect(page.records.map((record) => record.title)).toEqual(['kept'])
  })

  it('leaves an existing database without its marker byte-identical: this launch writes its text file, and reads refuse it', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    mkdirSync(dirname(paths.records), { recursive: true })
    const unmarked = new DatabaseSync(paths.records)
    unmarked.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, session TEXT NOT NULL, time TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, tape_id TEXT, fields TEXT NOT NULL)')
    unmarked.close()
    const bytes = readFileSync(paths.records)

    records.openRecords()
    expect(records.writeRecord('logs', {
      time: '2026-10-04T10:00:01.000Z', level: 'info', message: 'to the text file', tape_id: null, fields: '{}',
    }, () => 'to the text file')).toBe(false)
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow(/no format version/)
    records.closeRecords()

    expect(readFileSync(paths.records).equals(bytes)).toBe(true)
    const [file] = readdirSync(paths.logs)
    expect(readFileSync(join(paths.logs, file!), 'utf8').trim().split('\n').at(-1)).toBe('to the text file')
  })

  it('leaves a database in a newer format byte-identical: this launch writes its text file, and reads refuse it', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    mkdirSync(dirname(paths.records), { recursive: true })
    const newer = new DatabaseSync(paths.records)
    newer.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, future TEXT)')
    newer.exec('PRAGMA user_version = 2')
    newer.close()
    const bytes = readFileSync(paths.records)

    records.openRecords()
    expect(records.writeRecord('logs', {
      time: '2026-10-04T10:00:01.000Z', level: 'info', message: 'to the text file', tape_id: null, fields: '{}',
    }, () => 'to the text file')).toBe(false)
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow(/NewerFormatError/)
    records.closeRecords()

    expect(readFileSync(paths.records).equals(bytes)).toBe(true)
    const [file] = readdirSync(paths.logs)
    const lines = readFileSync(join(paths.logs, file!), 'utf8').trim().split('\n')
    expect(lines.at(-1)).toBe('to the text file')
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
      startedAt: '2026-10-04T10:00:03.000Z', endedAt: '2026-10-04T10:00:04.250Z', level: 'error',
      endpoint: 'https://api.openai.com/v1', model: 'gpt-x', request: JSON.stringify({ input: 'slug 100%' }),
      status: 429, response: JSON.stringify({ message: 'quota' }), error: JSON.stringify({ name: 'RateLimitError' }),
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'ytdlp-run', id: idOf('ytdlp-run') })).toMatchObject({
      kind: 'ytdlp-run', run: 'scan', scanId: 's1', url: 'https://example.com/list', level: 'info', exitCode: 0, signal: null,
      stopReason: null,
      args: JSON.stringify(['--flat-playlist']), stdout: 'found 3 entries', stderr: '',
    })
    expect(await reader.readRecords({ op: 'detail', kind: 'ffmpeg-run', id: idOf('ffmpeg-run') })).toMatchObject({
      kind: 'ffmpeg-run', run: 'thumbnail', tapeId: 't2', level: 'error', exitCode: 1, stopReason: null,
      stderr: 'Invalid data found',
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
