import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { databaseTransaction, openWritableDatabase } from '../io/sqlite-store.ts'
import { FORMATS, NewerFormatError, type FileWriter } from '../io/file-header.ts'
import { describeError } from '../../shared/error.ts'

/** A request without a file opens the store and records nothing: startup's check. */
export type BackupRequest = { id: number; absolutePath?: string; bytes?: Uint8Array }
/** `session`: this launch, so each file keeps one row per launch rather than one per save. */
export type BackupWorkerData = { databasePath: string; session: string; writer: FileWriter }
/** `refused`: the store was refused when it was opened, newer or unreadable, and left as it is. */
export type BackupResponse = { id: number; warning?: { message: string; fields: Record<string, unknown> }; disabled?: boolean; refused?: 'newer' | 'unreadable' }

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

if (!parentPort) throw new Error('The backup worker needs a parent port.')
const port = parentPort
const { databasePath, session, writer } = workerData as BackupWorkerData
let db: DatabaseSync | null = null
let initialized = false

port.on('message', (request: BackupRequest) => {
  const response: BackupResponse = { id: request.id }
  try {
    if (!initialized) {
      initialized = true
      try { db = openWritableDatabase(databasePath, FORMATS.backups, SCHEMA, writer) }
      catch (error) {
        response.disabled = true
        response.refused = error instanceof NewerFormatError ? 'newer' : 'unreadable'
        response.warning = { message: 'backup store: could not open; recording disabled for this session', fields: { file: databasePath, error: describeError(error) } }
      }
    }
    if (db && request.absolutePath !== undefined && request.bytes !== undefined) {
      const store = db
      const absolutePath = request.absolutePath
      const bytes = Buffer.from(request.bytes)
      const hash = createHash('sha256').update(bytes).digest('hex')
      // One row per file per launch: this launch's row takes the newest save; the
      // first save of a launch adds a row unless it repeats the newest one kept.
      databaseTransaction(store, true, () => {
        const writtenAt = new Date().toISOString()
        const own = store.prepare('SELECT id FROM backups WHERE path = ? AND session_id = ?').get(absolutePath, session) as { id: number } | undefined
        if (own) {
          store.prepare('UPDATE backups SET content = ?, content_sha256 = ?, byte_size = ?, written_at_utc = ? WHERE id = ?')
            .run(bytes, hash, bytes.byteLength, writtenAt, own.id)
          return
        }
        const latest = store.prepare('SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1').get(absolutePath) as { h: string } | undefined
        if (latest?.h === hash) return
        store.prepare('INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc, session_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(absolutePath, bytes, hash, bytes.byteLength, writtenAt, session)
      })
    }
  } catch (error) {
    response.warning = { message: 'backup store: failed to record a managed write', fields: { file: request.absolutePath, error: describeError(error) } }
  } finally {
    port.postMessage(response)
  }
})
