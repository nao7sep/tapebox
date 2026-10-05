import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { paths } from '@main/paths'
import { describeError } from '@shared/error'
import type { LogLevel } from '@shared/log'
import { utcTimestampForFilenameMs } from '@shared/utc'
import { toJson } from './log-format'
import { claimDatabaseFormat, FORMAT_VERSIONS } from './format-version'

/**
 * The records database, `records.sqlite3` under the storage root, per the
 * logging and data-lifecycle conventions. The main process is its one owner: the
 * renderer forwards its log entries over IPC (ipc/log.ts). The Records window
 * reads it on another thread through io/records-read.ts.
 *
 * Every row carries its session, this launch's start time, and the tape or
 * scan it concerns when there is one. No table is transient, so nothing here
 * deletes a row.
 *
 * Writes are synchronous, each one its own committed statement under
 * `synchronous = FULL`. A row the database refuses goes to this session's text
 * file under `logs/`, then to the console; nothing here throws.
 */
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

export type RecordTable = 'logs' | 'ai_calls' | 'ytdlp_runs' | 'ffmpeg_runs'
export type RecordRow = Record<string, SQLInputValue>

let session: string | null = null
let fallbackPath: string | null = null
let db: DatabaseSync | null = null
let closed = false
let failing = false
const statements = new Map<string, StatementSync>()
let storedListener: (() => void) | null = null

/** Start this launch's session and open the database. Returns the session. */
export function openRecords(): string {
  const started = new Date()
  session = started.toISOString()
  fallbackPath = join(paths.logs, `${utcTimestampForFilenameMs(started)}.log`)
  closed = false
  failing = false
  statements.clear()
  try {
    const opened = new DatabaseSync(paths.records)
    try {
      // A database in a newer format, or without its marker, is left exactly as it is
      // (store-recovery-conventions): checked before anything below writes to it, and
      // this launch writes the text file.
      claimDatabaseFormat(opened, paths.records, FORMAT_VERSIONS.records)
      opened.exec('PRAGMA journal_mode = WAL')
      opened.exec('PRAGMA synchronous = FULL')
      // A busy database costs one entry a text-file line, never a stalled main thread.
      opened.exec('PRAGMA busy_timeout = 100')
      opened.exec(SCHEMA)
    } catch (err) {
      opened.close()
      throw err
    }
    db = opened
  } catch (err) {
    db = null
    writeFallback(failureNote('records database could not be opened; writing to a text file', err))
  }
  return session
}

/** This launch's session, or null before {@link openRecords}. */
export function currentSession(): string | null {
  return session
}

/**
 * Called after each row the database stored, so the Records window can show it;
 * a row that went to the text file or the console is not in the database and
 * calls nothing.
 */
export function onRecordStored(listener: (() => void) | null): void {
  storedListener = listener
}

/** Close the database. Idempotent and synchronous, so an `exit` handler can call it. */
export function closeRecords(): void {
  closed = true
  statements.clear()
  const d = db
  db = null
  try {
    d?.close()
  } catch (err) {
    console.error('tapebox: records database did not close cleanly', err)
  }
}

/**
 * Insert one row. `text` is the row's plain-text form, built only when the row
 * goes to the text file or the console instead: before the session opens, after
 * it closes, or when the database refuses the row. Returns whether the row was
 * printed to the console.
 */
export function writeRecord(table: RecordTable, row: RecordRow, text: () => string, level: LogLevel = 'info'): boolean {
  if (session === null || closed) {
    toConsole(level, text())
    return true
  }
  if (db) {
    try {
      insert(db, table, row)
      failing = false
      notifyStored()
      return false
    } catch (err) {
      if (!failing) writeFallback(failureNote('records write failed; writing to a text file', err))
      failing = true
    }
  }
  return writeFallback(text(), level)
}

function insert(d: DatabaseSync, table: RecordTable, row: RecordRow): void {
  const columns = ['session', ...Object.keys(row)]
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  let statement = statements.get(sql)
  if (!statement) {
    statement = d.prepare(sql)
    statements.set(sql, statement)
  }
  statement.run(session, ...Object.values(row))
}

function notifyStored(): void {
  try {
    storedListener?.()
  } catch (err) {
    // Recording it would call the listener again, so the console is the record.
    toConsole('error', failureNote('records stored listener failed', err))
  }
}

function failureNote(message: string, err: unknown): string {
  return toJson({ time: new Date().toISOString(), level: 'error', message, error: describeError(err) })
}

function writeFallback(line: string, level: LogLevel = 'error'): boolean {
  const path = fallbackPath
  if (path) {
    try {
      mkdirSync(paths.logs, { recursive: true })
      appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`)
      return false
    } catch (err) {
      toConsole('error', failureNote('records text file could not be written; using the console', err))
    }
  }
  toConsole(level, line)
  return true
}

export function toConsole(level: LogLevel, line: string): void {
  const text = line.endsWith('\n') ? line.slice(0, -1) : line
  try {
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch {
    // If even the console is gone there is nothing left to try.
  }
}
