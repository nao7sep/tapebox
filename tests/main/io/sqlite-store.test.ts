import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { databaseTransaction, openWritableDatabase } from '@main/io/sqlite-store'

const FORMAT = { kind: 'records', version: 1 }
const WRITER = { name: 'tapebox', version: '1.0.0' }
// A format at version 2, so a store at 1 is a lower version.
const FORMAT2 = { kind: 'records', version: 2 }
const header = (db: DatabaseSync) => Object.fromEntries(
  (db.prepare('SELECT key, value FROM file_header ORDER BY key').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]),
)

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
  it('initializes the empty store an initializer left when it exited before committing', () => {
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
      openWritableDatabase(process.argv[2], { kind: 'records', version: 1 }, 'CREATE TABLE entries (value TEXT NOT NULL)', { name: 'tapebox', version: '1.0.0' });
    `, source, file], { encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(73)
    const db = openWritableDatabase(file, FORMAT, schema, WRITER)
    opened.push(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(db.prepare('SELECT * FROM entries').all()).toEqual([])
  })

  it.each(['negative', 'newer'])('leaves a preexisting %s store byte-identical', (kind) => {
    const file = join(root, 'store.sqlite3')
    const db = new DatabaseSync(file)
    try { db.exec(`PRAGMA user_version = ${kind === 'negative' ? -1 : 2}`) } finally { db.close() }
    const bytes = readFileSync(file)
    expect(() => openWritableDatabase(file, FORMAT, schema, WRITER)).toThrow(/format/)
    expect(readFileSync(file)).toEqual(bytes)
    expect(existsSync(`${file}-wal`)).toBe(false)
  })

  it('initializes a store whose first schema initialization failed, preserving the primary cause', () => {
    const file = join(root, 'store.sqlite3')
    const realClose = DatabaseSync.prototype.close
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
      realClose.call(this)
      throw new Error('secondary close failure')
    })
    expect(() => openWritableDatabase(file, FORMAT, `${schema}; invalid sql`, WRITER)).toThrow(/syntax/)
    expect(console.error).toHaveBeenCalledWith('tapebox: SQLite failed initialization close failed', expect.objectContaining({ message: 'secondary close failure' }))
    vi.mocked(DatabaseSync.prototype.close).mockRestore()
    const db = openWritableDatabase(file, FORMAT, schema, WRITER)
    opened.push(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
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
    expect(() => openWritableDatabase(file, FORMAT2, schema, WRITER)).toThrow(/format/)
    expect(readFileSync(file)).toEqual(bytes)
  })

  it('opens a current store with its existing rows intact', () => {
    const file = join(root, 'store.sqlite3')
    const idempotent = 'CREATE TABLE IF NOT EXISTS entries (value TEXT NOT NULL)'
    const first = openWritableDatabase(file, FORMAT, idempotent, WRITER)
    first.exec("INSERT INTO entries VALUES ('kept')")
    first.close()
    const reopened = openWritableDatabase(file, FORMAT, idempotent, WRITER)
    opened.push(reopened)
    expect(databaseTransaction(reopened, false, () => reopened.prepare('SELECT value FROM entries').all())).toEqual([{ value: 'kept' }])
  })
})

describe('SQLite store header', () => {
  const idempotent = 'CREATE TABLE IF NOT EXISTS entries (value TEXT NOT NULL)'

  it('gives a new store its header with its version', () => {
    const db = openWritableDatabase(join(root, 'store.sqlite3'), FORMAT, idempotent, WRITER)
    opened.push(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(header(db)).toEqual({ 'format.kind': 'records', 'format.owner': 'tapebox', 'writer.name': 'tapebox', 'writer.version': '1.0.0' })
  })

  it('rewrites the writer rows on every open for writing, dropping a caller, and never reads them', () => {
    const file = join(root, 'store.sqlite3')
    openWritableDatabase(file, FORMAT, idempotent, WRITER).close()
    const edited = new DatabaseSync(file)
    try {
      edited.exec("UPDATE file_header SET value = 'not-read' WHERE key LIKE 'writer.%'")
      edited.exec("INSERT INTO file_header VALUES ('writer.caller.name', 'someone')")
    } finally { edited.close() }
    const db = openWritableDatabase(file, FORMAT, idempotent, { name: 'tapebox', version: '1.0.1' })
    opened.push(db)
    expect(header(db)).toEqual({ 'format.kind': 'records', 'format.owner': 'tapebox', 'writer.name': 'tapebox', 'writer.version': '1.0.1' })
  })

  it.each([
    ['no file_header table', null],
    ['another owner', { 'format.owner': 'gptimg', 'format.kind': 'records' }],
    ['another kind', { 'format.owner': 'tapebox', 'format.kind': 'backups' }],
    ['no owner row', { 'format.kind': 'records' }],
  ])('refuses a store with %s, leaving it byte-identical', (_label, rows) => {
    const file = join(root, 'store.sqlite3')
    const other = new DatabaseSync(file)
    try {
      other.exec(schema)
      if (rows) {
        other.exec('CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        for (const [key, value] of Object.entries(rows)) other.prepare('INSERT INTO file_header VALUES (?, ?)').run(key, value)
      }
      other.exec('PRAGMA user_version = 1')
    } finally { other.close() }
    const bytes = readFileSync(file)
    expect(() => openWritableDatabase(file, FORMAT, idempotent, WRITER)).toThrow(/not a TapeBox records database/)
    expect(readFileSync(file)).toEqual(bytes)
  })
})
