/**
 * Tests for the write-through data-backup store (src/main/store/backupStore.ts). Pins the load-bearing
 * guarantees of the data-backup conventions:
 *
 *  - record inserts a row whose content BLOB is BYTE-IDENTICAL to the input, including a CR/LF and a
 *    non-UTF-8 byte, with a correct SHA-256, a correct byte_size, the FULL absolute path, and an
 *    ISO-8601-ms `written_at_utc` in the serialized form (`2026-07-06T04:05:12.345Z`) — asserted to be
 *    that shape and explicitly NOT the `yyyymmdd-hhmmss-fff-utc` filename stamp.
 *  - dedup: an unchanged re-save of the same path writes no new row; a changed save writes one; a revert
 *    to earlier content writes one (it differs from the immediately-preceding row).
 *  - best-effort: an injected insert failure never throws out of record, logs exactly one warn, and
 *    leaves prior rows untouched (the save it follows is unaffected). An unopenable store logs one warn
 *    and disables recording for the session (no repeat warn per save).
 *  - write-through: after a REAL managed save (loadSettings + updateSettings, which route through the
 *    writeManagedJson choke point), the exact bytes on disk are in the store, and an identical re-save is
 *    deduped.
 *
 * Rows are read back with an INDEPENDENT node:sqlite connection so the store's own writes — not a mock —
 * are what the assertions see. `@main/io/logger`'s `log` is mocked with a capturing logger so warn counts
 * are exact and no test writes into the developer's home dir. TAPEBOX_DATA_DIR points every store lookup at a
 * throwaway root, and closeBackupStore() + vi.resetModules() give each test a fresh singleton.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Capturing logger swapped in for @main/io/logger's `log` so warn/error lines are asserted exactly and
// nothing is written to the real session log. Hoisted so the vi.mock factory can close over it.
const logCalls = vi.hoisted(() => ({
  warn: [] as { message: string; fields?: Record<string, unknown> }[],
  error: [] as { message: string; fields?: Record<string, unknown> }[],
}))

// The launch each backup row belongs to, as the records' session would give it.
const launch = vi.hoisted(() => ({ id: 'first-launch' }))
vi.mock('@main/io/records', () => ({ currentSession: () => launch.id }))

vi.mock('@main/io/logger', () => ({
  log: {
    debug() {},
    info() {},
    warn: (message: string, fields?: Record<string, unknown>) => logCalls.warn.push({ message, fields }),
    error: (message: string, fields?: Record<string, unknown>) => logCalls.error.push({ message, fields }),
  },
}))

interface Row {
  id: number
  session_id: string | null
  path: string
  content: Uint8Array
  content_sha256: string
  byte_size: number
  written_at_utc: string
}

/** Read every row from the store with a fresh, independent connection (proves the store's own writes). */
function readRows(root: string): Row[] {
  const db = new DatabaseSync(path.join(root, 'backups.sqlite3'))
  try {
    return db.prepare('SELECT * FROM backups ORDER BY id').all() as unknown as Row[]
  } finally {
    db.close()
  }
}

let root: string
const prev = process.env.TAPEBOX_DATA_DIR

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tapebox-backupstore-'))
  process.env.TAPEBOX_DATA_DIR = root
  logCalls.warn.length = 0
  logCalls.error.length = 0
  launch.id = 'first-launch'
})

afterEach(async () => {
  if (prev === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = prev
  const { closeBackupStore } = await import('@main/store/backupStore')
  await closeBackupStore()
  vi.resetModules() // fresh singleton per test so each opens against its own throwaway root
  vi.doUnmock('node:sqlite')
  await rm(root, { recursive: true, force: true })
})

describe('record: BLOB fidelity, hash, size, path, and timestamp shape', () => {
  it('performs hashing and SQLite work through the real worker without opening SQLite on main', async () => {
    const backup = await import('@main/store/backupStore')
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(() => { throw new Error('main-thread SQLite must not run') })
    try {
      backup.record(path.join(root, 'config.json'), Buffer.from('off-thread bytes'))
      await backup.flushBackupStore()
    } finally { prepare.mockRestore() }
    expect(readRows(root)).toHaveLength(1)
    expect(logCalls.warn).toHaveLength(0)
  })
  it('stores byte-identical content (CR/LF + non-UTF-8 byte), correct sha256, size, absolute path, ISO-ms time', async () => {
    const { record, flushBackupStore } = await import('@main/store/backupStore')
    // A UTF-8 BOM, a CR/LF pair, and a lone 0xFF (invalid UTF-8) — reading this as a string then storing
    // it would normalize the CR/LF, alter the BOM, or corrupt the 0xFF. The BLOB must be verbatim.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0xff, 0x00, 0x63])
    const file = path.join(root, 'catalog.json')

    record(file, bytes)
    await flushBackupStore()

    const rows = readRows(root)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // Byte-identical: the exact bytes, not a decoded/normalized string.
    expect(Buffer.from(row.content).equals(bytes)).toBe(true)
    expect([...row.content]).toEqual([...bytes])
    // sha256 over those raw bytes.
    expect(row.content_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(row.byte_size).toBe(bytes.byteLength)
    // Full absolute path, stored verbatim.
    expect(row.path).toBe(file)
    expect(path.isAbsolute(row.path)).toBe(true)
    // written_at_utc is the serialized ISO-8601-ms form (a data value) — NOT a filename stamp.
    expect(row.written_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row.written_at_utc).not.toMatch(/utc$/) // never the yyyymmdd-hhmmss-fff-utc filename shape
    expect(row.written_at_utc).not.toMatch(/^\d{8}-/) // never the yyyymmdd- prefix of a filename stamp
    expect(new Date(row.written_at_utc).toISOString()).toBe(row.written_at_utc) // round-trips as an instant
    // Success logs nothing.
    expect(logCalls.warn).toHaveLength(0)
    expect(logCalls.error).toHaveLength(0)
  })
})

describe('one row per file per launch', () => {
  it('keeps the newest save of a launch in that launch\'s one row', async () => {
    const { record, flushBackupStore } = await import('@main/store/backupStore')
    const file = path.join(root, 'catalog.json')
    record(file, Buffer.from('alpha', 'utf8'))
    record(file, Buffer.from('alpha', 'utf8'))
    record(file, Buffer.from('beta', 'utf8'))
    await flushBackupStore()
    const rows = readRows(root)
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]!.content).toString('utf8')).toBe('beta')
    expect(rows[0]!.session_id).toBe(launch.id)
  })

  it('adds a row in a later launch unless its first save repeats the newest one kept', async () => {
    const file = path.join(root, 'catalog.json')
    const first = await import('@main/store/backupStore')
    first.record(file, Buffer.from('A', 'utf8'))
    await first.flushBackupStore()
    await first.closeBackupStore()

    vi.resetModules()
    launch.id = 'second-launch'
    const second = await import('@main/store/backupStore')
    second.record(file, Buffer.from('A', 'utf8')) // repeats what was kept: no row
    await second.flushBackupStore()
    expect(readRows(root)).toHaveLength(1)
    second.record(file, Buffer.from('B', 'utf8'))
    second.record(file, Buffer.from('A', 'utf8')) // a revert within the launch: its row takes it
    await second.flushBackupStore()
    expect(readRows(root).map((row) => [row.session_id, Buffer.from(row.content).toString('utf8')])).toEqual([
      ['first-launch', 'A'], ['second-launch', 'A'],
    ])
  })

  it('keeps each path\'s rows apart', async () => {
    const { record, flushBackupStore } = await import('@main/store/backupStore')
    const same = Buffer.from('shared', 'utf8')
    const p1 = path.join(root, 'config.json')
    const p2 = path.join(root, 'catalog.json')
    record(p1, same)
    record(p2, same)
    record(p1, same)
    await flushBackupStore()
    const rows = readRows(root)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.path).sort()).toEqual([p1, p2].sort())
  })
})

describe('best-effort: a record failure never throws, logs one warn, and does not disturb prior rows', () => {
  it('swallows an injected insert failure, logs exactly one warn, and leaves the earlier row intact', async () => {
    // First record a good row through the real binding so there is prior history to prove is untouched.
    {
      const { record, closeBackupStore } = await import('@main/store/backupStore')
      record(path.join(root, 'catalog.json'), Buffer.from('good', 'utf8'))
      await closeBackupStore()
    }
    expect(readRows(root)).toHaveLength(1)

    // A real SQLite trigger refuses the next insert without altering earlier
    // history; it also applies to the actual off-thread connection.
    const refusing = new DatabaseSync(path.join(root, 'backups.sqlite3'))
    try {
      refusing.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON backups BEGIN SELECT RAISE(FAIL, 'disk full: simulated insert failure'); END")
    } finally { refusing.close() }
    vi.resetModules()
    launch.id = 'second-launch'

    const { record, flushBackupStore } = await import('@main/store/backupStore')
    // A later launch and DIFFERENT content, so the save needs a new row and the insert is attempted.
    expect(() => record(path.join(root, 'catalog.json'), Buffer.from('changed', 'utf8'))).not.toThrow()
    await flushBackupStore()

    // Exactly one warn, naming the file and carrying a reason; no error line.
    expect(logCalls.warn).toHaveLength(1)
    expect(logCalls.warn[0]!.message).toMatch(/failed to record/i)
    expect(logCalls.warn[0]!.fields?.file).toBe(path.join(root, 'catalog.json'))
    expect(logCalls.warn[0]!.fields?.error).toBeDefined()
    expect(logCalls.error).toHaveLength(0)

    // The earlier good row is untouched — the failure disturbed nothing that had already been recorded.
    const rows = readRows(root)
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]!.content).toString('utf8')).toBe('good')
  })

  it('logs one warn and disables recording for the session when the store cannot be opened', async () => {
    // Point TAPEBOX_DATA_DIR at a path whose parent is a FILE, so mkdir + open cannot succeed. record must
    // not throw, must warn exactly once (open failure), and must no-op every subsequent call (no repeat
    // warn per save — disabled for the session).
    const { writeFileSync } = await import('node:fs')
    const blocker = path.join(root, 'blocker')
    writeFileSync(blocker, 'x') // a file where a directory would need to be
    process.env.TAPEBOX_DATA_DIR = path.join(blocker, 'nested') // parent is a file -> mkdir/open fails

    const { record, flushBackupStore } = await import('@main/store/backupStore')
    expect(() => record('/whatever/catalog.json', Buffer.from('a', 'utf8'))).not.toThrow()
    expect(() => record('/whatever/catalog.json', Buffer.from('b', 'utf8'))).not.toThrow()
    await flushBackupStore()

    // Exactly one warn total (the open failure), not one per record — disabled for the session.
    expect(logCalls.warn).toHaveLength(1)
    expect(logCalls.warn[0]!.message).toMatch(/could not open/i)
    expect(logCalls.error).toHaveLength(0)
  })
})

describe('write-through: a real managed save records the exact bytes after the rename', () => {
  it('the first changed set records config.json\'s exact on-disk bytes into the store', async () => {
    const { readFileSync } = await import('node:fs')
    const { loadSettings, updateSettings } = await import('@main/store/config')

    // First run does not write. The first user change goes through the managed-text
    // choke point, which records after the rename.
    await loadSettings()
    await updateSettings({ playSound: false })
    const { flushBackupStore } = await import('@main/store/backupStore')
    await flushBackupStore()

    const file = path.join(root, 'config.json')
    const onDisk = readFileSync(file) // the exact bytes the atomic write landed

    const rows = readRows(root)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.path).toBe(file) // full absolute path of the file as written
    expect(Buffer.from(row.content).equals(onDisk)).toBe(true) // byte-identical to what is on disk
    expect(row.content_sha256).toBe(createHash('sha256').update(onDisk).digest('hex'))
    expect(row.byte_size).toBe(onDisk.byteLength)
    expect(logCalls.warn).toHaveLength(0) // silent on success
  })

  it('keeps the launch\'s newest config.json in its one row', async () => {
    const { loadSettings, updateSettings } = await import('@main/store/config')

    await loadSettings()
    await updateSettings({ maxConcurrentDownloads: 3 })
    await updateSettings({ maxConcurrentDownloads: 5 })
    await updateSettings({ maxConcurrentDownloads: 5 })
    const { flushBackupStore } = await import('@main/store/backupStore')
    await flushBackupStore()

    const rows = readRows(root)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.path).toBe(path.join(root, 'config.json'))
    expect(JSON.parse(Buffer.from(rows[0]!.content).toString('utf8')).maxConcurrentDownloads).toBe(5)
    expect(logCalls.warn).toHaveLength(0)
  })
})

describe('format version (store-recovery-conventions)', () => {
  function userVersion(): number {
    const db = new DatabaseSync(path.join(root, 'backups.sqlite3'))
    try {
      return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    } finally {
      db.close()
    }
  }

  it('adopts the store v0.1.0 created without a marker, keeping its history', async () => {
    const file = path.join(root, 'backups.sqlite3')
    const v010 = new DatabaseSync(file)
    v010.exec(`CREATE TABLE backups (id INTEGER PRIMARY KEY, path TEXT NOT NULL, content BLOB NOT NULL,
      content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL)`)
    v010.prepare('INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)')
      .run(path.join(root, 'config.json'), Buffer.from('v0.1.0'), 'hash', 6, '2026-07-08T00:00:00.000Z')
    v010.close()
    const { record, flushBackupStore, closeBackupStore } = await import('@main/store/backupStore')

    record(path.join(root, 'config.json'), Buffer.from('after the upgrade'))
    await flushBackupStore()
    await closeBackupStore()

    expect(userVersion()).toBe(2)
    expect(readRows(root).map((row) => [row.session_id, Buffer.from(row.content).toString('utf8')])).toEqual([
      [null, 'v0.1.0'], ['first-launch', 'after the upgrade'],
    ])
    expect(logCalls.warn).toHaveLength(0)
  })

  it('leaves an unmarked store it does not recognize byte-identical, warning once and recording nothing', async () => {
    const file = path.join(root, 'backups.sqlite3')
    const unmarked = new DatabaseSync(file)
    unmarked.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)')
    unmarked.close()
    const bytes = readFileSync(file)
    const { record, flushBackupStore, closeBackupStore } = await import('@main/store/backupStore')

    record(path.join(root, 'config.json'), Buffer.from('a'))
    record(path.join(root, 'config.json'), Buffer.from('b'))
    await flushBackupStore()
    await closeBackupStore()

    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(logCalls.warn).toHaveLength(1)
    expect(userVersion()).toBe(0)
  })

  it('stamps format 2 on a store it creates, and records into it again after a relaunch', async () => {
    const first = await import('@main/store/backupStore')
    first.record(path.join(root, 'config.json'), Buffer.from('one'))
    await first.flushBackupStore()
    await first.closeBackupStore()
    expect(userVersion()).toBe(2)

    vi.resetModules()
    launch.id = 'second-launch'
    const relaunched = await import('@main/store/backupStore')
    relaunched.record(path.join(root, 'config.json'), Buffer.from('two'))
    await relaunched.flushBackupStore()
    expect(readRows(root)).toHaveLength(2)
  })

  it('leaves a store in a newer format byte-identical, warning once and recording nothing', async () => {
    const file = path.join(root, 'backups.sqlite3')
    const newer = new DatabaseSync(file)
    newer.exec('CREATE TABLE future (id INTEGER PRIMARY KEY)')
    newer.exec('PRAGMA user_version = 3')
    newer.close()
    const bytes = readFileSync(file)
    const { record, flushBackupStore, closeBackupStore } = await import('@main/store/backupStore')

    record(path.join(root, 'config.json'), Buffer.from('a'))
    record(path.join(root, 'config.json'), Buffer.from('b'))
    await flushBackupStore()
    await closeBackupStore()

    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(logCalls.warn).toHaveLength(1)
    expect(logCalls.warn[0]!.fields).toMatchObject({ error: expect.objectContaining({ name: 'NewerFormatError' }) })
  })

})
