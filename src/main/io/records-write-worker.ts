import { appendFileSync, mkdirSync } from 'node:fs'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { describeError } from '../../shared/error.ts'
import { toJson } from './log-format.ts'
import { FORMAT_VERSIONS } from './format-version.ts'
import { databaseTransaction, openWritableDatabase } from './sqlite-store.ts'

export type RecordTable = 'logs' | 'ai_calls' | 'ytdlp_runs' | 'ffmpeg_runs'
export type RecordRow = Record<string, SQLInputValue>
export type RecordWriteRequest = { id: number; table?: RecordTable; row?: RecordRow; text?: string; completion?: SharedArrayBuffer }
export type RecordWriteResponse = { id: number; stored: boolean; console?: string; diagnostics: string[] }
export type RecordWriteData = { databasePath: string; logsPath: string; fallbackPath: string; session: string; responsePort?: MessagePort }

const SCHEMA = `
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
    try { db = openWritableDatabase(data.databasePath, FORMAT_VERSIONS.records, SCHEMA) }
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
          statement.run(data.session, ...Object.values(row))
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
  // Publish the acknowledgement before releasing a terminal waiter.
  replyPort.postMessage(response)
  if (request.completion) {
    const completion = new Int32Array(request.completion)
    Atomics.store(completion, 0, 1)
    Atomics.notify(completion, 0)
  }
})
