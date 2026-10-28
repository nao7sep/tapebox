import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordsQuery } from '@shared/records'

// The Records window's reads, through the real reader thread over a real
// records database written by io/records.ts.

const prevHome = process.env.TAPEBOX_DATA_DIR
const roots: string[] = []
const closers: Array<() => void | Promise<void>> = []

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

afterEach(async () => {
  vi.useRealTimers()
  for (const close of closers.splice(0)) await close()
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

async function seed(records: Records): Promise<void> {
  logRow(records, '2026-10-04T10:00:01.000Z', 'info', 'job start', 't1', JSON.stringify({ tapeId: 't1', url: 'https://example.com/v' }))
  logRow(records, '2026-10-04T10:00:02.000Z', 'warn', 'download stalled', 't1')
  records.writeRecord('ai_calls', {
    tape_id: 't1', started_at_utc: '2026-10-04T10:00:03.000Z', ended_at_utc: '2026-10-04T10:00:04.250Z',
    endpoint: 'https://api.openai.com/v1', model: 'gpt-x', request: JSON.stringify({ input: 'slug 100%' }),
    status: 429, response: JSON.stringify({ message: 'quota' }), error: JSON.stringify({ name: 'RateLimitError' }),
  }, () => 'ai call')
  records.writeOutputChunk('seed-ytdlp', 'stdout', 0, 'found 3 entries')
  records.writeOutputChunk('seed-ffmpeg', 'stderr', 0, 'Invalid data found')
  records.writeRecord('ytdlp_runs', {
    tape_id: null, scan_id: 's1', kind: 'scan', url: 'https://example.com/list', args: JSON.stringify(['--flat-playlist']),
    started_at_utc: '2026-10-04T10:00:05.000Z', ended_at_utc: '2026-10-04T10:00:06.000Z', exit_code: 0, signal: null,
    stdout: '', stderr: '',
  }, () => 'yt-dlp run', 'info', false, { outputKey: 'seed-ytdlp', outputChunks: { stdout: 1, stderr: 0 } })
  records.writeRecord('ffmpeg_runs', {
    tape_id: 't2', kind: 'thumbnail', args: JSON.stringify(['-i', 'in.webp']),
    started_at_utc: '2026-10-04T10:00:07.000Z', ended_at_utc: '2026-10-04T10:00:07.500Z', exit_code: 1, signal: null,
    stdout: '', stderr: '',
  }, () => 'ffmpeg run', 'info', false, { outputKey: 'seed-ffmpeg', outputChunks: { stdout: 0, stderr: 1 } })
  // The fixture needs committed rows. Ordinary reads do not drain future or
  // unrelated submitted diagnostics; production change notices follow ACKs.
  await records.flushRecords()
}

describe('records reads', () => {
  it('reads committed WAL page, detail and sources while an unrelated admitted write stays held', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    const session = records.openRecords()
    logRow(records, '2026-10-04T10:00:01.000Z', 'info', 'committed seed', 'SeedTape01')
    await records.flushRecords()
    const listed = await reader.readRecords({ op: 'page', query: query() })
    const seedId = listed.records[0]!.id
    const check = new DatabaseSync(paths.records, { readOnly: true })
    try { expect(check.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' }) }
    finally { check.close() }

    const postMessage = Worker.prototype.postMessage
    const releases: Array<() => void> = []
    const dispatched: string[] = []
    const heldWrite = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, value, transferList) {
      if (value.read) dispatched.push(value.read.op)
      if (value.table === 'logs' && value.row?.message === 'held unrelated insert') {
        releases.push(() => postMessage.call(this, value, transferList))
        return
      }
      postMessage.call(this, value, transferList)
    })
    records.writeRecord('logs', { time: '2026-10-04T10:00:02.000Z', level: 'info', message: 'held unrelated insert', tape_id: null, fields: '{}' }, () => 'held unrelated insert')
    expect(releases).toHaveLength(1)
    const page = reader.readRecords({ op: 'page', query: query() })
    const detail = reader.readRecords({ op: 'detail', kind: 'log', id: seedId })
    const sources = reader.readRecords({ op: 'sources' })
    let drained = false
    const drain = records.flushRecords().then(() => { drained = true })
    try {
      // Observe actual reader dispatch while the unrelated writer request has
      // not crossed its boundary, rather than asserting a wall-clock bound.
      await Promise.resolve()
      expect(dispatched).toEqual(['page', 'detail', 'sources'])
      expect((await page).records.map((record) => record.title)).toEqual(['committed seed'])
      expect(await detail).toMatchObject({ id: seedId, message: 'committed seed', tapeId: 'SeedTape01' })
      expect(await sources).toEqual({ sessions: [session], tapeIds: ['SeedTape01'] })
      expect(drained).toBe(false)
      expect(releases).toHaveLength(1)
    } finally {
      for (const release of releases.splice(0)) release()
      await Promise.allSettled([page, detail, sources])
      await drain
      heldWrite.mockRestore()
    }
  })

  it('lets the reader report cold database initialization failure instead of claiming ready storage', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    mkdirSync(paths.records)
    records.openRecords()
    await records.flushRecords()
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow()
  })

  it('pages every kind newest first, a failed call or run reading as an error', async () => {
    const { records, reader } = await freshApp()
    const session = records.openRecords()
    await seed(records)

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
    await seed(records)
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
    await records.flushRecords()

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

  it('stores execution facts beside their unchanged rows and uses semantic run success', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    records.openRecords()
    const row = {
      tape_id: 't1', kind: 'probe', args: '[]', started_at_utc: '2026-10-04T10:00:07.000Z',
      ended_at_utc: '2026-10-04T09:00:00.000Z', exit_code: 1, signal: null, stop_reason: null,
      stdout: '', stderr: 'Duration: 00:00:01.00',
    }
    records.writeRecord('ffmpeg_runs', row, () => 'probe', 'info', false, { elapsedMs: 1250, succeeded: true })
    records.writeRecord('ffmpeg_runs', { ...row, stop_reason: 'cancel' }, () => 'cancel', 'info', false, { elapsedMs: 50, succeeded: false })
    records.writeRecord('ffmpeg_runs', { ...row, stderr: 'Invalid data found' }, () => 'failed', 'info', false, { elapsedMs: 20, succeeded: false })
    records.writeRecord('ffmpeg_runs', row, () => 'historical')
    await records.flushRecords()
    const page = await reader.readRecords({ op: 'page', query: query({ kind: 'ffmpeg-run' }) })
    expect(page.records.map((record) => record.level)).toEqual(['error', 'error', 'warn', 'info'])
    const good = page.records.at(-1)!
    expect(await reader.readRecords({ op: 'detail', kind: 'ffmpeg-run', id: good.id })).toMatchObject({
      elapsedMs: 1250, level: 'info', exitCode: 1, endedAt: row.ended_at_utc,
    })
    expect((await reader.readRecords({ op: 'page', query: query({ level: 'error' }) })).records).toHaveLength(2)
    const db = new DatabaseSync(paths.records, { readOnly: true })
    try {
      expect(db.prepare('SELECT elapsed_ms, succeeded FROM execution_facts WHERE record_table = ? AND record_id = ?').get('ffmpeg_runs', good.id))
        .toMatchObject({ elapsed_ms: 1250, succeeded: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_facts').get()).toMatchObject({ count: 3 })
    } finally { db.close() }
  })

  it('rolls back the record when its execution facts cannot be stored', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    records.openRecords()
    await records.flushRecords()
    const db = new DatabaseSync(paths.records)
    try {
      db.exec("CREATE TRIGGER reject_execution_facts BEFORE INSERT ON execution_facts BEGIN SELECT RAISE(ABORT, 'fixture refused facts'); END")
      records.writeRecord('ai_calls', {
        tape_id: 't1', started_at_utc: '2026-10-04T10:00:00.000Z', ended_at_utc: '2026-10-04T10:00:01.000Z',
        endpoint: 'https://example.test', model: 'fixture', request: null, status: null, response: null, error: null,
      }, () => 'fixture failed write', 'info', false, { elapsedMs: 1000, succeeded: true })
      await records.flushRecords()
      expect((await reader.readRecords({ op: 'page', query: query() })).records).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_facts').get()).toMatchObject({ count: 0 })
    } finally { db.close() }
  })

  it('stamps format 1 on a database it creates, and reads it back', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    records.openRecords()
    await records.flushRecords()
    logRow(records, '2026-10-04T10:00:01.000Z', 'info', 'kept')
    await records.closeRecords()
    const check = new DatabaseSync(paths.records, { readOnly: true })
    try {
      expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    } finally { check.close() }

    records.openRecords()
    const page = await reader.readRecords({ op: 'page', query: query() })
    expect(page.records.map((record) => record.title)).toEqual(['kept'])
  })

  it('leaves an existing database without its marker byte-identical: this launch writes its text file, and reads refuse it', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    mkdirSync(dirname(paths.records), { recursive: true })
    const unmarked = new DatabaseSync(paths.records)
    try {
      unmarked.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, session TEXT NOT NULL, time TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, tape_id TEXT, fields TEXT NOT NULL)')
    } finally { unmarked.close() }
    const bytes = readFileSync(paths.records)

    records.openRecords()
    expect(records.writeRecord('logs', {
      time: '2026-10-04T10:00:01.000Z', level: 'info', message: 'to the text file', tape_id: null, fields: '{}',
    }, () => 'to the text file')).toBe(false)
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow(/no format version/)
    await records.closeRecords()

    expect(readFileSync(paths.records).equals(bytes)).toBe(true)
    const [file] = readdirSync(paths.logs)
    expect(readFileSync(join(paths.logs, file!), 'utf8').trim().split('\n').at(-1)).toBe('to the text file')
  })

  it('leaves a database in a newer format byte-identical: this launch writes its text file, and reads refuse it', async () => {
    const { records, reader } = await freshApp()
    const { paths } = await import('@main/paths')
    mkdirSync(dirname(paths.records), { recursive: true })
    const newer = new DatabaseSync(paths.records)
    try {
      newer.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, future TEXT)')
      newer.exec('PRAGMA user_version = 2')
    } finally { newer.close() }
    const bytes = readFileSync(paths.records)

    records.openRecords()
    expect(records.writeRecord('logs', {
      time: '2026-10-04T10:00:01.000Z', level: 'info', message: 'to the text file', tape_id: null, fields: '{}',
    }, () => 'to the text file')).toBe(false)
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow(/NewerFormatError/)
    await records.closeRecords()

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
    await records.flushRecords()

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
    await seed(records)
    const page = await reader.readRecords({ op: 'page', query: query() })
    const idOf = (kind: string) => page.records.find((record) => record.kind === kind)!.id

    expect(await reader.readRecords({ op: 'detail', kind: 'ai-call', id: idOf('ai-call') })).toEqual({
      kind: 'ai-call', id: idOf('ai-call'), session, tapeId: 't1',
      startedAt: '2026-10-04T10:00:03.000Z', endedAt: '2026-10-04T10:00:04.250Z', elapsedMs: null, level: 'error',
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
    await seed(records)

    expect(await reader.readRecords({ op: 'sources' })).toEqual({ sessions: [session], tapeIds: ['t2', 't1'] })
  })

  it('fails a read the database cannot answer, and reads again afterwards', async () => {
    const { records, reader } = await freshApp()
    // No database has been opened yet, so the read-only reader finds no file.
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow()

    const session = records.openRecords()
    await seed(records)
    expect((await reader.readRecords({ op: 'sources' })).sessions).toEqual([session])
  })
})
