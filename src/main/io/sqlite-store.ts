import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/** Open a current writable store. New stores are complete before the final
 * name is published; an interrupted private stage cannot block the next launch.
 * Existing unsupported stores remain intact and are refused. */
export function openWritableDatabase(path: string, current: number, schema: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  let initialized = false
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    initialized = initializeDatabase(path, current, schema)
  }
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 100')
    db.exec('PRAGMA synchronous = FULL')
    databaseTransaction(db, true, () => {
      assertDatabaseCurrent(db, path, current)
      const version = databaseFormatVersion(db, path)
      if (version !== current) throw new Error(`${path} is format ${version}; this build requires format ${current}`)
      if (!initialized) db.exec(schema)
    })
    return db
  } catch (error) {
    closeAfterFailure(db)
    throw error
  }
}

function closeAfterFailure(db: DatabaseSync | undefined): void {
  try { db?.close() } catch (cleanupError) { console.error('tapebox: SQLite failed initialization close failed', cleanupError) }
}

function initializeDatabase(path: string, current: number, schema: string): boolean {
  const stage = mkdtempSync(join(dirname(path), `${basename(path)}-init-`))
  const file = join(stage, 'store.sqlite3')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file)
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA journal_mode = WAL')
    databaseTransaction(db, true, () => {
      db!.exec(schema)
      db!.exec(`PRAGMA user_version = ${current}`)
    })
    // Consolidate WAL bytes before publishing only the database file.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    const descriptor = openSync(file, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    try {
      linkSync(file, path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false // Admit the competing store normally below.
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(code ?? '')) throw error
      // On volumes without links, publish complete bytes by rename. This store
      // has one app writer; an external creator between this check and rename
      // remains the platform's accepted no-link publication limitation.
      try { lstatSync(path); return false } catch (lookupError) {
        if ((lookupError as NodeJS.ErrnoException).code !== 'ENOENT') throw lookupError
      }
      renameSync(file, path)
    }
    syncPublishedDirectory(dirname(path))
    return true
  } catch (error) {
    closeAfterFailure(db)
    throw error
  } finally {
    try { rmSync(stage, { recursive: true, force: true }) } catch (error) {
      console.error('tapebox: SQLite private stage cleanup failed', error)
    }
  }
}

function syncPublishedDirectory(path: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const unsupported = code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' ||
      (process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES'))
    // Publication already committed; keep the complete store and report genuine
    // durability failures without deleting it or pretending creation failed.
    if (!unsupported) console.error('tapebox: SQLite directory sync failed after publication', error)
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch (error) { console.error('tapebox: SQLite directory close failed', error) }
    }
  }
}
