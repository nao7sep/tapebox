import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { readRecords, type RecordsRead, type RecordsReadResult } from './records-query.ts'

/**
 * The Records window's reader thread (records-read.ts starts it). It holds its
 * own read-only connection to records.sqlite3, which the main process keeps
 * writing in WAL mode, so a read never waits on a write and never blocks the
 * main thread. Its imports are relative and its aliases type-only, so Node runs
 * this source as it is under the tests.
 */

export type RecordsWorkerData = { databasePath: string }

export type RecordsWorkerRequest = { id: number; read: RecordsRead }

export type RecordsWorkerResponse =
  | { id: number; ok: true; value: RecordsReadResult }
  | { id: number; ok: false; error: string }

// A busy database fails the read after this long instead of holding it.
const BUSY_TIMEOUT_MS = 2_000

if (parentPort === null) throw new Error('The records worker needs a parent port.')
const port = parentPort
const { databasePath } = workerData as RecordsWorkerData
let db: DatabaseSync | null = null

function open(): DatabaseSync {
  if (db !== null) return db
  const opened = new DatabaseSync(databasePath, { readOnly: true })
  try {
    opened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  } catch (error) {
    opened.close()
    throw error
  }
  db = opened
  return opened
}

port.on('message', ({ id, read }: RecordsWorkerRequest) => {
  let response: RecordsWorkerResponse
  try {
    response = { id, ok: true, value: readRecords(open(), read) }
  } catch (error) {
    response = { id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
  port.postMessage(response)
})
