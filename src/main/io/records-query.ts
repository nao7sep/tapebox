import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  RecordDetail,
  RecordKind,
  RecordsPage,
  RecordsQuery,
  RecordSummary,
} from '@shared/records'

/**
 * The Records window's reads of records.sqlite3 (io/records.ts owns the schema
 * and the writes). Pure queries over an open database, so the reader worker
 * (records-worker.ts) runs them off the main thread and tests run them directly.
 * Only type imports leave this file, so Node can run it as the worker's source.
 */

export type RecordsRead =
  | { op: 'page'; query: RecordsQuery }
  | { op: 'sources' }
  | { op: 'detail'; kind: RecordKind; id: number }

export type RecordsReadResults = {
  page: RecordsPage
  sources: { sessions: string[]; tapeIds: string[] }
  detail: RecordDetail | null
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
const RUN_LEVEL =
  "CASE WHEN stop_reason IN ('cancel', 'quit') THEN 'warn' WHEN exit_code = 0 THEN 'info' ELSE 'error' END"

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
    level: RUN_LEVEL,
    title: "'yt-dlp ' || kind",
    text: 'url',
    searched: ['kind', 'url', 'args', 'tape_id', 'scan_id', 'stdout', 'stderr'],
  },
  {
    kind: 'ffmpeg-run',
    table: 'ffmpeg_runs',
    time: 'started_at_utc',
    level: RUN_LEVEL,
    title: "'ffmpeg ' || kind",
    text: 'NULL',
    searched: ['kind', 'args', 'tape_id', 'stdout', 'stderr'],
  },
]

export function readRecords(db: DatabaseSync, read: RecordsRead): RecordsReadResult {
  if (read.op === 'page') return readPage(db, read.query)
  if (read.op === 'sources') return readSources(db)
  return readDetail(db, read.kind, read.id)
}

function likePattern(search: string): string | null {
  const trimmed = search.trim()
  return trimmed === '' ? null : `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

export function readPage(db: DatabaseSync, query: RecordsQuery): RecordsPage {
  const pattern = likePattern(query.search)
  const parts: string[] = []
  const params: SQLInputValue[] = []
  for (const source of SOURCES) {
    if (query.kind !== null && query.kind !== source.kind) continue
    const where = ['1 = 1']
    if (query.session !== null) {
      where.push('session = ?')
      params.push(query.session)
    }
    if (query.level === 'attention') {
      where.push(`${source.level} IN ('warn', 'error')`)
    } else if (query.level !== null) {
      where.push(`${source.level} = ?`)
      params.push(query.level)
    }
    if (query.tapeId !== null) {
      where.push('tape_id = ?')
      params.push(query.tapeId)
    }
    if (pattern !== null) {
      where.push(`(${source.searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      params.push(...source.searched.map(() => pattern))
    }
    parts.push(
      `SELECT '${source.kind}' AS kind, id, session, ${source.time} AS time, ${source.level} AS level,
        ${source.title} AS title, ${source.text} AS text, tape_id AS tapeId
        FROM ${source.table} WHERE ${where.join(' AND ')}`,
    )
  }
  let after = ''
  if (query.after !== null) {
    const { time, kind, id } = query.after
    after = 'WHERE time < ? OR (time = ? AND (kind < ? OR (kind = ? AND id < ?)))'
    params.push(time, time, kind, kind, id)
  }
  params.push(RECORDS_PAGE_SIZE + 1)
  const rows = db
    .prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) ${after} ORDER BY time DESC, kind DESC, id DESC LIMIT ?`)
    .all(...params) as unknown as RecordSummary[]
  return { records: rows.slice(0, RECORDS_PAGE_SIZE), more: rows.length > RECORDS_PAGE_SIZE }
}

export function readSources(db: DatabaseSync): RecordsReadResults['sources'] {
  const sessions = db
    .prepare(SOURCES.map((source) => `SELECT session FROM ${source.table}`).join(' UNION ') + ' ORDER BY session DESC')
    .all() as { session: string }[]
  const tapes = db
    .prepare(
      `SELECT tape_id AS tapeId, MAX(time) AS last FROM (
        ${SOURCES.map((source) => `SELECT tape_id, ${source.time} AS time FROM ${source.table}`).join(' UNION ALL ')}
      ) WHERE tape_id IS NOT NULL GROUP BY tape_id ORDER BY last DESC`,
    )
    .all() as { tapeId: string }[]
  return { sessions: sessions.map((row) => row.session), tapeIds: tapes.map((row) => row.tapeId) }
}

const DETAIL_SQL: Readonly<Record<RecordKind, string>> = {
  log: `SELECT 'log' AS kind, id, session, time, level, message, tape_id AS tapeId, fields FROM logs WHERE id = ?`,
  'ai-call': `SELECT 'ai-call' AS kind, id, session, tape_id AS tapeId, started_at_utc AS startedAt,
    ended_at_utc AS endedAt, ${CALL_LEVEL} AS level, endpoint, model, request, status, response, error
    FROM ai_calls WHERE id = ?`,
  'ytdlp-run': `SELECT 'ytdlp-run' AS kind, id, session, tape_id AS tapeId, scan_id AS scanId, kind AS run, url, args,
    started_at_utc AS startedAt, ended_at_utc AS endedAt, ${RUN_LEVEL} AS level, exit_code AS exitCode, signal,
    stop_reason AS stopReason, stdout, stderr FROM ytdlp_runs WHERE id = ?`,
  'ffmpeg-run': `SELECT 'ffmpeg-run' AS kind, id, session, tape_id AS tapeId, kind AS run, args,
    started_at_utc AS startedAt, ended_at_utc AS endedAt, ${RUN_LEVEL} AS level, exit_code AS exitCode, signal,
    stop_reason AS stopReason, stdout, stderr FROM ffmpeg_runs WHERE id = ?`,
}

export function readDetail(db: DatabaseSync, kind: RecordKind, id: number): RecordDetail | null {
  const row = db.prepare(DETAIL_SQL[kind]).get(id)
  return (row as unknown as RecordDetail | undefined) ?? null
}
