import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertDatabaseCurrent, databaseFormatVersion } from './format-version.ts'

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
 * initialized in place, including one an interrupted first launch left behind.
 * Existing unsupported stores remain intact and are refused. */
export function openWritableDatabase(path: string, current: number, schema: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 100')
    db.exec('PRAGMA synchronous = FULL')
    // The journal mode persists in the file and cannot change inside a
    // transaction, so only a new store gets it, before its marker exists.
    if (databaseFormatVersion(db, path) === null) db.exec('PRAGMA journal_mode = WAL')
    databaseTransaction(db, true, () => {
      if (databaseFormatVersion(db, path) === null) {
        db.exec(schema)
        db.exec(`PRAGMA user_version = ${current}`)
        return
      }
      assertDatabaseCurrent(db, path, current)
      const version = databaseFormatVersion(db, path)
      if (version !== current) throw new Error(`${path} is format ${version}; this build requires format ${current}`)
      db.exec(schema)
    })
    return db
  } catch (error) {
    try { db.close() } catch (cleanupError) { console.error('tapebox: SQLite failed initialization close failed', cleanupError) }
    throw error
  }
}
