import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  RecordDetail,
  RecordKind,
  RecordsPage,
  RecordsQuery,
  RecordSummary,
  RunOutputPage,
  RunOutputQuery,
} from '@shared/records'

/**
 * The Records window's reads of records.sqlite3 (io/records.ts owns the schema
 * and the writes). Pure queries over an open database, so the records writer
 * thread (records-write-worker.ts) runs them on its connection and tests run them
 * directly. Only type imports leave this file, so Node can run it as the worker's
 * source.
 */

export type RecordsRead =
  | { op: 'page'; query: RecordsQuery }
  | { op: 'sources' }
  | { op: 'detail'; kind: RecordKind; id: number }
  | ({ op: 'output' } & RunOutputQuery)

export type RecordsReadResults = {
  page: RecordsPage
  sources: { sessions: string[]; tapeIds: string[] }
  detail: RecordDetail | null
  output: RunOutputPage
}

export type RecordsReadResult = RecordsReadResults[RecordsRead['op']]

export const RECORDS_PAGE_SIZE = 100

// How a summary reads from each table. Only a log line has a level of its own;
// the others are read from their facts, as RECORD_LEVEL_FILTERS describes.
type Source = {
  kind: RecordKind
  table: string
  time: string
  level: string
  title: string
  text: string
  searched: string[]
}

const CALL_LEVEL = "CASE WHEN error IS NULL THEN 'info' ELSE 'error' END"
function executionFact(table: string, column: 'succeeded' | 'elapsed_ms'): string {
  return `(SELECT ${column} FROM execution_facts WHERE record_table = '${table}' AND record_id = ${table}.id)`
}

function runLevel(table: string): string {
  return `CASE WHEN stop_reason IN ('cancel', 'quit') THEN 'warn'
    WHEN COALESCE(${executionFact(table, 'succeeded')}, exit_code = 0) THEN 'info' ELSE 'error' END`
}

const SOURCES: readonly Source[] = [
  {
    kind: 'log',
    table: 'logs',
    time: 'time',
    level: 'level',
    title: 'message',
    text: 'NULL',
    searched: ['message', 'tape_id', 'fields'],
  },
  {
    kind: 'ai-call',
    table: 'ai_calls',
    time: 'started_at_utc',
    level: CALL_LEVEL,
    title: 'model',
    text: 'endpoint',
    searched: ['endpoint', 'model', 'tape_id', 'request', 'response', 'error'],
  },
  {
    kind: 'ytdlp-run',
    table: 'ytdlp_runs',
    time: 'started_at_utc',
    level: runLevel('ytdlp_runs'),
    title: "'yt-dlp ' || kind",
    text: 'url',
    searched: ['kind', 'url', 'args', 'tape_id', 'scan_id'],
  },
  {
    kind: 'ffmpeg-run',
    table: 'ffmpeg_runs',
    time: 'started_at_utc',
    level: runLevel('ffmpeg_runs'),
    title: "'ffmpeg ' || kind",
    text: 'NULL',
    searched: ['kind', 'args', 'tape_id'],
  },
]

export function readRecords(db: DatabaseSync, read: RecordsRead): RecordsReadResult {
  if (read.op === 'page') return readPage(db, read.query)
  if (read.op === 'output') return readOutput(db, read)
  if (read.op === 'sources') return readSources(db)
  return readDetail(db, read.kind, read.id)
}

function likePattern(search: string): string | null {
  const trimmed = search.trim()
  return trimmed === '' ? null : `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

export function readPage(db: DatabaseSync, query: RecordsQuery): RecordsPage {
  const pattern = likePattern(query.search)
  if (pattern !== null) registerOutputSearch(db)
  const parts: string[] = []
  const params: SQLInputValue[] = []
  for (const source of SOURCES) {
    if (query.kind !== null && query.kind !== source.kind) continue
    const level = source.level
    const where = ['1 = 1']
    if (query.session !== null) {
      where.push('session = ?')
      params.push(query.session)
    }
    if (query.level === 'attention') {
      where.push(`${level} IN ('warn', 'error')`)
    } else if (query.level !== null) {
      where.push(`${level} = ?`)
      params.push(query.level)
    }
    if (query.tapeId !== null) {
      where.push('tape_id = ?')
      params.push(query.tapeId)
    }
    if (pattern !== null) {
      const searched = source.searched.map((column) => `${column} LIKE ? ESCAPE '\\'`)
      params.push(...source.searched.map(() => pattern))
      if (source.kind === 'ytdlp-run' || source.kind === 'ffmpeg-run') {
        searched.push(`EXISTS (SELECT 1 FROM run_outputs AS output
          WHERE output.record_table = '${source.table}' AND output.record_id = ${source.table}.id
          AND output_contains(${source.table}.session, output.run_key, ?) = 1)`)
        params.push(query.search.trim())
      }
      where.push(`(${searched.join(' OR ')})`)
    }
    if (query.after !== null) {
      const { time, kind, id } = query.after
      // Each branch has a fixed Records kind (a run's native kind means
      // something else). Reduce the global cursor tuple to this source's
      // chronological range, so SQLite can seek its time/id index.
      if (source.kind < kind) {
        where.push(`${source.time} <= ?`)
        params.push(time)
      } else if (source.kind > kind) {
        where.push(`${source.time} < ?`)
        params.push(time)
      } else {
        where.push(`${source.time} <= ? AND (${source.time} < ? OR id < ?)`)
        params.push(time, time, id)
      }
    }
    parts.push(
      `SELECT '${source.kind}' AS kind, id, session, ${source.time} AS time, ${level} AS level,
        ${source.title} AS title, ${source.text} AS text, tape_id AS tapeId
        FROM ${source.table} WHERE ${where.join(' AND ')}`,
    )
  }
  params.push(RECORDS_PAGE_SIZE + 1)
  const rows = db
    // Order the compound query directly. An outer SELECT made SQLite scan and
    // sort all kept rows; this form merges the indexed source streams.
    .prepare(`${parts.join(' UNION ALL ')} ORDER BY time DESC, kind DESC, id DESC LIMIT ?`)
    .all(...params) as unknown as RecordSummary[]
  return { records: rows.slice(0, RECORDS_PAGE_SIZE), more: rows.length > RECORDS_PAGE_SIZE }
}

const outputSearchConnections = new WeakSet<DatabaseSync>()

/** SQLite LIKE folds ASCII only. Keep that same literal-substring behavior
 * while carrying enough overlap to find a match across any number of chunks. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

function registerOutputSearch(db: DatabaseSync): void {
  if (outputSearchConnections.has(db)) return
  db.function('output_contains', { directOnly: true }, (session, runKey, search) => {
    const needle = asciiLowercase(search as string)
    let tail = ''
    let previousStream: string | null = null
    let previousSequence = -1
    const chunks = db.prepare(`SELECT stream, sequence, content FROM run_output_chunks
      WHERE session = ? AND run_key = ? ORDER BY stream, sequence`).iterate(session, runKey)
    for (const value of chunks) {
      const chunk = value as { stream: string; sequence: number; content: string }
      if (chunk.stream !== previousStream || chunk.sequence !== previousSequence + 1) tail = ''
      previousStream = chunk.stream
      previousSequence = chunk.sequence
      const joined = tail + asciiLowercase(chunk.content)
      if (joined.includes(needle)) return 1
      tail = needle.length > 1 ? joined.slice(-(needle.length - 1)) : ''
    }
    return 0
  })
  outputSearchConnections.add(db)
}

export function readSources(db: DatabaseSync): RecordsReadResults['sources'] {
  const sessions = db
    .prepare(SOURCES.map((source) => `SELECT session FROM ${source.table}`).join(' UNION ') + ' ORDER BY session DESC')
    .all() as { session: string }[]
  const tapes = db
    .prepare(
      `SELECT tape_id AS tapeId, MAX(time) AS last FROM (
        ${SOURCES.map((source) => `SELECT tape_id, ${source.time} AS time FROM ${source.table}`).join(' UNION ALL ')}
      ) WHERE tape_id IS NOT NULL GROUP BY tape_id ORDER BY last DESC, tapeId`,
    )
    .all() as { tapeId: string }[]
  return { sessions: sessions.map((row) => row.session), tapeIds: tapes.map((row) => row.tapeId) }
}

const DETAIL_SQL: Readonly<Record<RecordKind, string>> = {
  log: `SELECT 'log' AS kind, id, session, time, level, message, tape_id AS tapeId, fields FROM logs WHERE id = ?`,
  'ai-call': `SELECT 'ai-call' AS kind, id, session, tape_id AS tapeId, started_at_utc AS startedAt,
    ended_at_utc AS endedAt, ${executionFact('ai_calls', 'elapsed_ms')} AS elapsedMs, ${CALL_LEVEL} AS level, endpoint, model, request, status, response, error
    FROM ai_calls WHERE id = ?`,
  'ytdlp-run': `SELECT 'ytdlp-run' AS kind, id, session, tape_id AS tapeId, scan_id AS scanId, kind AS run, url, args,
    started_at_utc AS startedAt, ended_at_utc AS endedAt, ${executionFact('ytdlp_runs', 'elapsed_ms')} AS elapsedMs, ${runLevel('ytdlp_runs')} AS level, exit_code AS exitCode, signal,
    stop_reason AS stopReason FROM ytdlp_runs WHERE id = ?`,
  'ffmpeg-run': `SELECT 'ffmpeg-run' AS kind, id, session, tape_id AS tapeId, kind AS run, args,
    started_at_utc AS startedAt, ended_at_utc AS endedAt, ${executionFact('ffmpeg_runs', 'elapsed_ms')} AS elapsedMs, ${runLevel('ffmpeg_runs')} AS level, exit_code AS exitCode, signal,
    stop_reason AS stopReason FROM ffmpeg_runs WHERE id = ?`,
}

export function readDetail(db: DatabaseSync, kind: RecordKind, id: number): RecordDetail | null {
  const sql = DETAIL_SQL[kind]
  const row = (db.prepare(sql).get(id) as unknown as RecordDetail | undefined) ?? null
  if (row?.kind === 'ytdlp-run' || row?.kind === 'ffmpeg-run') {
    const mapping = outputMapping(db, row.kind, id)
    if (!mapping) return { ...row, stdout: '', stderr: '', stdoutMore: false, stderrMore: false, outputStatus: 'unknown' }
    const stdout = readChunk(db, mapping, 'stdout', 0)
    const stderr = readChunk(db, mapping, 'stderr', 0)
    return { ...row, stdout: stdout.text, stderr: stderr.text, stdoutMore: stdout.more, stderrMore: stderr.more, outputStatus: outputStatus(db, mapping) }
  }
  return row
}

type OutputMapping = { session: string; runKey: string }

function outputMapping(db: DatabaseSync, kind: RunOutputQuery['kind'], id: number): OutputMapping | undefined {
  const table = kind === 'ytdlp-run' ? 'ytdlp_runs' : 'ffmpeg_runs'
  return db.prepare(`SELECT run.session, output.run_key AS runKey FROM ${table} AS run
    JOIN run_outputs AS output ON output.record_table = ? AND output.record_id = run.id WHERE run.id = ?`)
    .get(table, id) as OutputMapping | undefined
}

function readChunk(db: DatabaseSync, mapping: OutputMapping, stream: RunOutputQuery['stream'], page: number): RunOutputPage {
  // A chunk can fall back to the text log while a later chunk reaches SQLite.
  // Keep later retained evidence reachable even when this sequence is absent.
  const row = db.prepare(`SELECT
    COALESCE((SELECT content FROM run_output_chunks WHERE session = ? AND run_key = ? AND stream = ? AND sequence = ?), '') AS text,
    EXISTS(SELECT 1 FROM run_output_chunks WHERE session = ? AND run_key = ? AND stream = ? AND sequence > ?) AS more`)
    .get(mapping.session, mapping.runKey, stream, page, mapping.session, mapping.runKey, stream, page) as { text: string; more: number }
  return { text: row.text, more: Boolean(row.more) }
}

export function readOutput(db: DatabaseSync, query: RunOutputQuery): RunOutputPage {
  const mapping = outputMapping(db, query.kind, query.id)
  return mapping ? readChunk(db, mapping, query.stream, query.page) : { text: '', more: false }
}

function outputStatus(db: DatabaseSync, mapping: OutputMapping): 'complete' | 'incomplete' | 'unknown' {
  const rows = db.prepare(`SELECT expected.stream, expected.expected_chunks AS expected,
    COUNT(chunk.sequence) AS retained, MIN(chunk.sequence) AS first, MAX(chunk.sequence) AS last
    FROM run_output_extents AS expected LEFT JOIN run_output_chunks AS chunk
      ON chunk.session = expected.session AND chunk.run_key = expected.run_key AND chunk.stream = expected.stream
    WHERE expected.session = ? AND expected.run_key = ? GROUP BY expected.stream`)
    .all(mapping.session, mapping.runKey) as Array<{ stream: string; expected: number; retained: number; first: number | null; last: number | null }>
  if (rows.length !== 2) return 'unknown'
  return rows.every((row) => row.retained === row.expected &&
    (row.expected === 0 || (row.first === 0 && row.last === row.expected - 1))) ? 'complete' : 'incomplete'
}
