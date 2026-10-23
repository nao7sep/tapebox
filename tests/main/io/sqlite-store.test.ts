import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
  it('can create the store after the initializer exits before publication', () => {
    const file = join(root, 'store.sqlite3')
    const source = new URL('../../../src/main/io/sqlite-store.ts', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const { openWritableDatabase } = await import(process.argv[1]);
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (sql === 'COMMIT') process.exit(73);
        return exec.call(this, sql);
      };
      openWritableDatabase(process.argv[2], 1, 'CREATE TABLE entries (value TEXT NOT NULL)');
    `, source, file], { encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(73)
    expect(existsSync(file)).toBe(false)
    const db = openWritableDatabase(file, 1, schema)
    opened.push(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(db.prepare('SELECT * FROM entries').all()).toEqual([])
  })

  it('preserves a competing unsupported store created before publication', () => {
    const file = join(root, 'store.sqlite3')
    const realExec = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') writeFileSync(file, '')
      return realExec.call(this, sql)
    })
    expect(() => openWritableDatabase(file, 1, schema)).toThrow(/format/)
    expect(readFileSync(file)).toEqual(Buffer.alloc(0))
  })

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

  it.each([0, 1])('refuses an unsupported format %s store without altering its rows', (version) => {
    const file = join(root, 'store.sqlite3')
    const earlier = new DatabaseSync(file)
    try {
      earlier.exec(schema)
      earlier.exec("INSERT INTO entries VALUES ('kept')")
      earlier.exec(`PRAGMA user_version = ${version}`)
    } finally { earlier.close() }
    const bytes = readFileSync(file)
    expect(() => openWritableDatabase(file, 2, schema)).toThrow(/format/)
    expect(readFileSync(file)).toEqual(bytes)
  })

  it('opens a current store with its existing rows intact', () => {
    const file = join(root, 'store.sqlite3')
    const idempotent = 'CREATE TABLE IF NOT EXISTS entries (value TEXT NOT NULL)'
    const first = openWritableDatabase(file, 2, idempotent)
    first.exec("INSERT INTO entries VALUES ('kept')")
    first.close()
    const reopened = openWritableDatabase(file, 2, idempotent)
    opened.push(reopened)
    expect(databaseTransaction(reopened, false, () => reopened.prepare('SELECT value FROM entries').all())).toEqual([{ value: 'kept' }])
  })
})
