import { appendFileSync, mkdirSync } from 'node:fs'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { describeError } from '../../shared/error.ts'
import { toJson } from './log-format.ts'
import { FORMAT_VERSIONS } from './format-version.ts'
import { databaseTransaction, openWritableDatabase } from './sqlite-store.ts'

export type RecordTable = 'logs' | 'ai_calls' | 'ytdlp_runs' | 'ffmpeg_runs'
export type RecordRow = Record<string, SQLInputValue>
export type ExecutionFacts = { elapsedMs?: number | null; succeeded?: boolean | null; outputKey?: string; outputChunks?: { stdout: number; stderr: number } }
export type RecordWriteRequest = { facts?: ExecutionFacts; id: number; chunk?: { runKey: string; stream: 'stdout' | 'stderr'; sequence: number; content: string }; table?: RecordTable; row?: RecordRow; text?: string; completion?: SharedArrayBuffer }
export type RecordWriteResponse = { id: number; stored: boolean; console?: string; diagnostics: string[] }
/** `textOnly`: the replacement for a writer that stalled, which writes only the
 *  text file and never opens the database that stalled it. */
export type RecordWriteData = { databasePath: string; logsPath: string; fallbackPath: string; session: string; responsePort?: MessagePort; textOnly?: boolean }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_output_chunks (
  session TEXT NOT NULL,
  run_key TEXT NOT NULL,
  stream TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (session, run_key, stream, sequence)
);
CREATE TABLE IF NOT EXISTS run_outputs (
  record_table TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  run_key TEXT NOT NULL,
  PRIMARY KEY (record_table, record_id)
);

CREATE TABLE IF NOT EXISTS run_output_extents (
  session TEXT NOT NULL,
  run_key TEXT NOT NULL,
  stream TEXT NOT NULL,
  expected_chunks INTEGER NOT NULL,
  PRIMARY KEY (session, run_key, stream)
);

CREATE TABLE IF NOT EXISTS execution_facts (
  record_table TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  elapsed_ms REAL,
  succeeded INTEGER,
  PRIMARY KEY (record_table, record_id)
);
CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  time    TEXT NOT NULL,
  level   TEXT NOT NULL,
  message TEXT NOT NULL,
  tape_id TEXT,
  fields  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs (session);
CREATE INDEX IF NOT EXISTS idx_logs_tape_id ON logs (tape_id);
CREATE INDEX IF NOT EXISTS idx_logs_time_id ON logs (time DESC, id DESC);
CREATE TABLE IF NOT EXISTS ai_calls (
  id             INTEGER PRIMARY KEY,
  session        TEXT NOT NULL,
  tape_id        TEXT,
  started_at_utc TEXT NOT NULL,
  ended_at_utc   TEXT NOT NULL,
  endpoint       TEXT NOT NULL,
  model          TEXT NOT NULL,
  request        TEXT,
  status         INTEGER,
  response       TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_session ON ai_calls (session);
CREATE INDEX IF NOT EXISTS idx_ai_calls_tape_id ON ai_calls (tape_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_time_id ON ai_calls (started_at_utc DESC, id DESC);
CREATE TABLE IF NOT EXISTS ytdlp_runs (
  id             INTEGER PRIMARY KEY,
  session        TEXT NOT NULL,
  tape_id        TEXT,
  scan_id        TEXT,
  kind           TEXT NOT NULL,
  url            TEXT NOT NULL,
  args           TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  ended_at_utc   TEXT NOT NULL,
  exit_code      INTEGER,
  signal         TEXT,
  stop_reason    TEXT,
  stdout         TEXT NOT NULL,
  stderr         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ytdlp_runs_session ON ytdlp_runs (session);
CREATE INDEX IF NOT EXISTS idx_ytdlp_runs_tape_id ON ytdlp_runs (tape_id);
CREATE INDEX IF NOT EXISTS idx_ytdlp_runs_time_id ON ytdlp_runs (started_at_utc DESC, id DESC);
CREATE TABLE IF NOT EXISTS ffmpeg_runs (
  id             INTEGER PRIMARY KEY,
  session        TEXT NOT NULL,
  tape_id        TEXT,
  kind           TEXT NOT NULL,
  args           TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  ended_at_utc   TEXT NOT NULL,
  exit_code      INTEGER,
  signal         TEXT,
  stop_reason    TEXT,
  stdout         TEXT NOT NULL,
  stderr         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ffmpeg_runs_session ON ffmpeg_runs (session);
CREATE INDEX IF NOT EXISTS idx_ffmpeg_runs_tape_id ON ffmpeg_runs (tape_id);
CREATE INDEX IF NOT EXISTS idx_ffmpeg_runs_time_id ON ffmpeg_runs (started_at_utc DESC, id DESC);
`

if (!parentPort) throw new Error('The Records writer needs a parent port.')
const port = parentPort
const data = workerData as RecordWriteData
const replyPort = data.responsePort ?? port
let db: DatabaseSync | null = null
let initialized = false
let failing = false
const statements = new Map<string, StatementSync>()

function failureNote(message: string, error: unknown): string {
  return toJson({ time: new Date().toISOString(), level: 'error', message, error: describeError(error) })
}

function fallback(line: string, response: RecordWriteResponse, diagnostic = false): void {
  try {
    mkdirSync(data.logsPath, { recursive: true })
    appendFileSync(data.fallbackPath, line.endsWith('\n') ? line : `${line}\n`)
  } catch (error) {
    response.diagnostics.push(failureNote('records text file could not be written; using the console', error))
    if (diagnostic) response.diagnostics.push(line)
    else response.console = line
  }
}

port.on('message', (request: RecordWriteRequest) => {
  const response: RecordWriteResponse = { id: request.id, stored: false, diagnostics: [] }
  if (!initialized) {
    initialized = true
    if (data.textOnly) fallback(failureNote('records writer replaced after a stall; writing to a text file', new Error('replaced')), response, true)
    else try { db = openWritableDatabase(data.databasePath, FORMAT_VERSIONS.records, SCHEMA) }
    catch (error) { fallback(failureNote('records database could not be opened; writing to a text file', error), response, true) }
  }
  if (request.table && request.row) {
    const row = request.row
    if (db) {
      const store = db
      try {
        databaseTransaction(store, true, () => {
          const columns = ['session', ...Object.keys(row)]
          const sql = `INSERT INTO ${request.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
          let statement = statements.get(sql)
          if (!statement) { statement = store.prepare(sql); statements.set(sql, statement) }
          const inserted = statement.run(data.session, ...Object.values(row))
          if (request.facts?.outputKey) {
            store.prepare('INSERT INTO run_outputs (record_table, record_id, run_key) VALUES (?, ?, ?)')
              .run(request.table!, inserted.lastInsertRowid, request.facts.outputKey)
            if (request.facts.outputChunks) for (const stream of ['stdout', 'stderr'] as const) {
              store.prepare('INSERT INTO run_output_extents (session, run_key, stream, expected_chunks) VALUES (?, ?, ?, ?)')
                .run(data.session, request.facts.outputKey, stream, request.facts.outputChunks[stream])
            }
          }
          if (request.facts) {
            store.prepare('INSERT INTO execution_facts (record_table, record_id, elapsed_ms, succeeded) VALUES (?, ?, ?, ?)')
              .run(request.table!, inserted.lastInsertRowid, request.facts.elapsedMs ?? null,
                request.facts.succeeded == null ? null : Number(request.facts.succeeded))
          }
        })
        response.stored = true
        failing = false
      } catch (error) {
        if (!failing) fallback(failureNote('records write failed; writing to a text file', error), response, true)
        failing = true
      }
    }
    if (!response.stored) fallback(request.text ?? '', response)
  }
  if (request.chunk) {
    let stored = false
    if (db) try {
      const chunk = request.chunk
      db.prepare('INSERT INTO run_output_chunks (session, run_key, stream, sequence, content) VALUES (?, ?, ?, ?, ?)')
        .run(data.session, chunk.runKey, chunk.stream, chunk.sequence, chunk.content)
      stored = true
      failing = false
    } catch (error) {
      if (!failing) fallback(failureNote('records output write failed; writing to a text file', error), response, true)
      failing = true
    }
    if (!stored) fallback(request.text ?? '', response)
    // Chunks are invisible until their completed metadata row is published.
  }
  // Publish the acknowledgement before releasing a terminal waiter.
  replyPort.postMessage(response)
  if (request.completion) {
    const completion = new Int32Array(request.completion)
    Atomics.store(completion, 0, 1)
    Atomics.notify(completion, 0)
  }
})
