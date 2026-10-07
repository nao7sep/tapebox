import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { databaseTransaction, openWritableDatabase } from '@main/io/sqlite-store'

let root: string
const opened: DatabaseSync[] = []
const schema = 'CREATE TABLE entries (value TEXT NOT NULL)'

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tapebox-sqlite-')) })
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of opened.splice(0)) db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('SQLite store admission', () => {
  it.each(['empty', 'negative', 'newer'])('leaves a preexisting %s store byte-identical', (kind) => {
    const file = join(root, 'store.sqlite3')
    if (kind === 'empty') writeFileSync(file, '')
    else {
      const db = new DatabaseSync(file)
      try { db.exec(`PRAGMA user_version = ${kind === 'negative' ? -1 : 2}`) } finally { db.close() }
    }
    const bytes = readFileSync(file)
    expect(() => openWritableDatabase(file, 1, schema)).toThrow(/format/)
    expect(readFileSync(file)).toEqual(bytes)
    expect(existsSync(`${file}-wal`)).toBe(false)
  })

  it('removes only its newly created database when schema initialization fails, preserving the primary cause', () => {
    const file = join(root, 'store.sqlite3')
    const realClose = DatabaseSync.prototype.close
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
      realClose.call(this)
      throw new Error('secondary close failure')
    })
    expect(() => openWritableDatabase(file, 1, `${schema}; invalid sql`)).toThrow(/syntax/)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
    expect(console.error).toHaveBeenCalledWith('tapebox: SQLite failed initialization close failed', expect.objectContaining({ message: 'secondary close failure' }))
  })

  it('checks a changed marker inside each transaction and recovers after a refused operation', () => {
    const file = join(root, 'store.sqlite3')
    const db = openWritableDatabase(file, 1, schema)
    opened.push(db)
    databaseTransaction(db, file, 1, true, () => db.exec("INSERT INTO entries VALUES ('first')"))
    const other = new DatabaseSync(file)
    try {
      other.exec('PRAGMA user_version = 2')
      expect(() => databaseTransaction(db, file, 1, true, () => db.exec("INSERT INTO entries VALUES ('refused')"))).toThrow(/format 2/)
      expect(other.prepare('SELECT value FROM entries').all()).toEqual([{ value: 'first' }])
      other.exec('PRAGMA user_version = 1')
      expect(databaseTransaction(db, file, 1, false, () => db.prepare('SELECT value FROM entries').all())).toEqual([{ value: 'first' }])
    } finally { other.close() }
  })
})
