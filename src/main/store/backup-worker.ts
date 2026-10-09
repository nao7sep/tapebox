import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { databaseTransaction, openWritableDatabase } from '../io/sqlite-store.ts'
import { FORMAT_VERSIONS } from '../io/format-version.ts'
import { describeError } from '../../shared/error.ts'

export type BackupRequest = { id: number; absolutePath: string; bytes: Uint8Array }
export type BackupResponse = { id: number; warning?: { message: string; fields: Record<string, unknown> }; disabled?: boolean }

const COLUMNS = ['id', 'path', 'content', 'content_sha256', 'byte_size', 'written_at_utc']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  written_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_path_id ON backups (path, id);
`

if (!parentPort) throw new Error('The backup worker needs a parent port.')
const port = parentPort
const { databasePath } = workerData as { databasePath: string }
let db: DatabaseSync | null = null
let initialized = false

port.on('message', (request: BackupRequest) => {
  const response: BackupResponse = { id: request.id }
  try {
    if (!initialized) {
      initialized = true
      try { db = openWritableDatabase(databasePath, FORMAT_VERSIONS.backups, SCHEMA, isV010BackupStore) }
      catch (error) {
        response.disabled = true
        response.warning = { message: 'backup store: could not open; recording disabled for this session', fields: { file: databasePath, error: describeError(error) } }
      }
    }
    if (db) {
      const store = db
      const bytes = Buffer.from(request.bytes)
      const hash = createHash('sha256').update(bytes).digest('hex')
      databaseTransaction(store, true, () => {
        const latest = store.prepare('SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1').get(request.absolutePath) as { h: string } | undefined
        if (latest?.h === hash) return
        store.prepare('INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)')
          .run(request.absolutePath, bytes, hash, bytes.byteLength, new Date().toISOString())
      })
    }
  } catch (error) {
    response.warning = { message: 'backup store: failed to record a managed write', fields: { file: request.absolutePath, error: describeError(error) } }
  } finally {
    port.postMessage(response)
  }
})

/** TapeBox v0.1.0 created this same `backups` table without a format marker. */
function isV010BackupStore(store: DatabaseSync): boolean {
  const tables = store.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
  if (tables.length !== 1 || tables[0]!.name !== 'backups') return false
  const columns = (store.prepare('PRAGMA table_info(backups)').all() as { name: string }[]).map((column) => column.name)
  return columns.length === COLUMNS.length && columns.every((name, index) => name === COLUMNS[index])
}
