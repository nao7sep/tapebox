import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertDatabaseCurrent, databaseFormatVersion, writeDatabaseHeader, type FileFormat, type FileWriter } from './file-header.ts'

/** Run one operation in its own SQLite transaction. */
export function databaseTransaction<T>(db: DatabaseSync, write: boolean, run: () => T): T {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch (cleanupError) { console.error('tapebox: SQLite rollback failed', cleanupError) }
    throw error
  }
}

/** Open a current writable store. An empty database at version 0 is new and is
 * initialized in place, including one an interrupted first launch left behind,
 * with its header. Existing unsupported stores remain intact and are refused; a
 * current one has its writer rows rewritten. Its owner's thread holds the
 * store's only connection, so it sets no busy timeout. */
export function openWritableDatabase(path: string, format: FileFormat, schema: string, writer: FileWriter): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA synchronous = FULL')
    // The journal mode persists in the file and cannot change inside a
    // transaction, so only a new store gets it, before its marker exists.
    if (databaseFormatVersion(db, path) === null) db.exec('PRAGMA journal_mode = WAL')
    databaseTransaction(db, true, () => {
      if (databaseFormatVersion(db, path) === null) {
        db.exec(schema)
        writeDatabaseHeader(db, format, writer)
        db.exec(`PRAGMA user_version = ${format.version}`)
        return
      }
      assertDatabaseCurrent(db, path, format)
      db.exec(schema)
      writeDatabaseHeader(db, format, writer)
    })
    return db
  } catch (error) {
    try { db.close() } catch (cleanupError) { console.error('tapebox: SQLite failed initialization close failed', cleanupError) }
    throw error
  }
}
