import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertDatabaseCurrent } from './format-version.ts'

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

/** Only a successful exclusive creation can initialize an unmarked database,
 * apart from one `adoptUnmarked` recognizes as an earlier unmarked form of it,
 * which is marked current. */
export function openWritableDatabase(
  path: string,
  current: number,
  schema: string,
  adoptUnmarked?: (db: DatabaseSync) => boolean,
): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  let created = false
  let db: DatabaseSync | undefined
  try {
    try {
      const descriptor = openSync(path, 'wx')
      created = true
      closeSync(descriptor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 100')
    db.exec('PRAGMA synchronous = FULL')
    // Existing stores already use their established journal. Only our new file
    // can have a persistent pragma applied before its marker exists.
    if (created) db.exec('PRAGMA journal_mode = WAL')
    db.exec('BEGIN IMMEDIATE')
    try {
      const adopted = !created && adoptUnmarked !== undefined && isUnmarkedWithTables(db) && adoptUnmarked(db)
      if (!created && !adopted) assertDatabaseCurrent(db, path, current)
      db.exec(schema)
      if (created || adopted) db.exec(`PRAGMA user_version = ${current}`)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (cleanupError) { console.error('tapebox: SQLite initialization rollback failed', cleanupError) }
      throw error
    }
    return db
  } catch (error) {
    try { db?.close() } catch (cleanupError) { console.error('tapebox: SQLite failed initialization close failed', cleanupError) }
    if (created) {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try { unlinkSync(file) } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') console.error('tapebox: SQLite failed creation cleanup failed', cleanupError)
        }
      }
    }
    throw error
  }
}

function isUnmarkedWithTables(db: DatabaseSync): boolean {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version !== 0) return false
  const { tables } = db.prepare("SELECT count(*) AS tables FROM sqlite_schema WHERE type = 'table'").get() as { tables: number }
  return tables > 0
}
