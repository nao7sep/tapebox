import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { databaseTransaction, openWritableDatabase } from '../io/sqlite-store.ts'
import { FORMAT_VERSIONS } from '../io/format-version.ts'
import { describeError } from '../../shared/error.ts'

export type BackupRequest = { id: number; absolutePath: string; bytes: Uint8Array }
/** `session`: this launch, so each file keeps one row per launch (data-backup conventions). */
export type BackupWorkerData = { databasePath: string; session: string }
export type BackupResponse = { id: number; warning?: { message: string; fields: Record<string, unknown> }; disabled?: boolean }

/** The v0.1.0 and format 1 table, which had no launch column. */
const COLUMNS = ['id', 'path', 'content', 'content_sha256', 'byte_size', 'written_at_utc']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  written_at_utc TEXT NOT NULL,
  session_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_path_id ON backups (path, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_path_session ON backups (path, session_id);
`

/** Format 1 to 2: add the launch column; earlier rows keep a null launch, which
 *  the unique index allows any number of. */
function upgrade(store: DatabaseSync, from: number): void {
  if (from === 1) store.exec('ALTER TABLE backups ADD COLUMN session_id TEXT')
}

if (!parentPort) throw new Error('The backup worker needs a parent port.')
const port = parentPort
const { databasePath, session } = workerData as BackupWorkerData
let db: DatabaseSync | null = null
let initialized = false

port.on('message', (request: BackupRequest) => {
  const response: BackupResponse = { id: request.id }
  try {
    if (!initialized) {
      initialized = true
      try { db = openWritableDatabase(databasePath, FORMAT_VERSIONS.backups, SCHEMA, { adoptUnmarked: isV010BackupStore, upgrade }) }
      catch (error) {
        response.disabled = true
        response.warning = { message: 'backup store: could not open; recording disabled for this session', fields: { file: databasePath, error: describeError(error) } }
      }
    }
    if (db) {
      const store = db
      const bytes = Buffer.from(request.bytes)
      const hash = createHash('sha256').update(bytes).digest('hex')
      // One row per file per launch: this launch's row takes the newest save; the
      // first save of a launch adds a row unless it repeats the newest one kept.
      databaseTransaction(store, true, () => {
        const writtenAt = new Date().toISOString()
        const own = store.prepare('SELECT id FROM backups WHERE path = ? AND session_id = ?').get(request.absolutePath, session) as { id: number } | undefined
        if (own) {
          store.prepare('UPDATE backups SET content = ?, content_sha256 = ?, byte_size = ?, written_at_utc = ? WHERE id = ?')
            .run(bytes, hash, bytes.byteLength, writtenAt, own.id)
          return
        }
        const latest = store.prepare('SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1').get(request.absolutePath) as { h: string } | undefined
        if (latest?.h === hash) return
        store.prepare('INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc, session_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(request.absolutePath, bytes, hash, bytes.byteLength, writtenAt, session)
      })
    }
  } catch (error) {
    response.warning = { message: 'backup store: failed to record a managed write', fields: { file: request.absolutePath, error: describeError(error) } }
  } finally {
    port.postMessage(response)
  }
})

/** TapeBox v0.1.0 created format 1's `backups` table without a format marker. */
function isV010BackupStore(store: DatabaseSync): number | null {
  const tables = store.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
  if (tables.length !== 1 || tables[0]!.name !== 'backups') return null
  const columns = (store.prepare('PRAGMA table_info(backups)').all() as { name: string }[]).map((column) => column.name)
  return columns.length === COLUMNS.length && columns.every((name, index) => name === COLUMNS[index]) ? 1 : null
}
