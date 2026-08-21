/**
 * The write-through data-backup store (data-backup conventions). It owns one add-only SQLite file,
 * `backups.sqlite3`, directly under TapeBox's storage root (`TAPEBOX_HOME` or `~/.tapebox`, resolved in
 * one place by {@link paths} — never a hardcoded path). Every managed *text* save records the exact bytes
 * it just wrote here, strictly AFTER its atomic rename lands, so the history is always as current as the
 * last save. There is no startup scan, no periodic pass, no restore path.
 *
 * SQLite binding: Node's built-in `node:sqlite` (`DatabaseSync`), not better-sqlite3. In an Electron main
 * process better-sqlite3 is a native addon that must be rebuilt against Electron's Node ABI on every
 * Electron bump. `node:sqlite` is built into Node and needs no native build. Its synchronous calls run
 * from a one-at-a-time `setImmediate` queue, after the save has returned, so hashing and SQLite lock
 * waits never lengthen the managed-file save path. It returns a BLOB as a `Uint8Array`, wrapped in a
 * Buffer here for byte-identical hashing and compare.
 *
 * Two absolute musts drive every line below (they are not best-effort aspirations):
 *
 *  - It never breaks a save and never crashes the app. The save has already succeeded — the file is on
 *    disk before {@link record} is called — so any failure here (the DB is locked, the disk is full, an
 *    insert throws) is caught, logged once at `warn`, and swallowed. A lost record self-heals on the next
 *    save of that file, whose content will differ from the last recorded row.
 *  - It logs only failures. A successful record logs NOTHING; a line per save would flood the log.
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { paths } from '@main/paths'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'

/**
 * The one add-only table. `content` is a BLOB of the exact bytes written — never decoded text, so CR/LF,
 * a BOM, and non-UTF-8 bytes are stored byte-identically. `written_at_utc` is the serialized ISO-8601-ms
 * form (`2026-07-06T04:05:12.345Z`), a data value — NEVER the `yyyymmdd-hhmmss-fff-utc` filename stamp.
 * The `(path, id)` index serves the latest-row-per-path dedup lookup.
 */
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

/** Module-level singleton, resolved once. A `null` DB means recording is disabled for this session
 *  because the store could not be opened — a single warn was already logged; every later {@link record}
 *  becomes a no-op rather than retrying (and re-logging) a broken open on every save. */
let db: DatabaseSync | null = null
let initialized = false
type PendingRecord = { absolutePath: string; bytes: Buffer }
const pending: PendingRecord[] = []
let draining = false
let accepting = true
let idleWaiters: Array<() => void> = []
const CLOSE_DRAIN_TIMEOUT_MS = 1_000

/**
 * Open and initialize the store once (create the table if absent, switch on WAL). Best-effort: on any
 * failure it logs ONE warn, leaves recording disabled for the session, and never throws. WAL is what lets
 * the tolerated two-instance case (two TapeBox windows writing at once) serialize safely without a
 * cross-process lock.
 */
function ensureOpen(): DatabaseSync | null {
  if (initialized) return db
  initialized = true
  try {
    const file = paths.backupsDb
    // not recorded: backups.sqlite3 is the store itself — binary, and written by this backup layer, not
    // through the managed-text atomic-write path — so it never records itself. No recursion, no special
    // case (data-backup conventions: "A binary store, excluded from itself").
    // The first writer under the root does the `mkdir -p` (storage-path convention); the store may be the
    // first thing written on a fresh root.
    mkdirSync(dirname(file), { recursive: true })
    const opened = new DatabaseSync(file)
    opened.exec('PRAGMA journal_mode = WAL')
    // Keep lock contention bounded tightly. A backup is best-effort; freezing the Electron main thread
    // for seconds is worse than dropping one history row and recording the next save.
    opened.exec('PRAGMA busy_timeout = 100')
    opened.exec(SCHEMA)
    db = opened
  } catch (err) {
    log.warn('backup store: could not open; recording disabled for this session', {
      file: paths.backupsDb,
      error: describeError(err),
    })
    db = null
  }
  return db
}

/** SHA-256 of the exact bytes, lowercase hex. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Record one managed-text write: `absolutePath` is the FULL absolute path of the file as written;
 * `bytes` is the exact raw bytes just written (the caller already holds them — never re-read the file).
 *
 * Dedup by content hash per path: the new content's SHA-256 is compared against the latest row for the
 * same `path`, and the insert is SKIPPED when they are equal. This collapses consecutive identical saves
 * (an autosave with no real change writes no row) while still recording every genuinely distinct version
 * — including a revert, whose content differs from the immediately preceding row.
 *
 * Best-effort and silent on success; any failure is caught, logged once at `warn` (file + reason), and
 * swallowed. It never throws, never crashes the app, and never breaks the save.
 */
function recordNow(absolutePath: string, bytes: Buffer): void {
  const store = ensureOpen()
  if (!store) return // open failed earlier; disabled for the session (already warned once)
  try {
    const hash = sha256(bytes)
    const latest = store
      .prepare('SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1')
      .get(absolutePath) as { h: string } | undefined
    if (latest?.h === hash) return // unchanged since the last recorded version — dedup skip

    store
      .prepare(
        'INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)',
      )
      .run(absolutePath, bytes, hash, bytes.byteLength, new Date().toISOString())
  } catch (err) {
    log.warn('backup store: failed to record a managed write', {
      file: absolutePath,
      error: describeError(err),
    })
  }
}

function resolveIdle(): void {
  if (draining || pending.length > 0) return
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve()
}

function scheduleDrain(): void {
  if (draining || pending.length === 0) return
  draining = true
  setImmediate(() => {
    const next = pending.shift()
    if (next) recordNow(next.absolutePath, next.bytes)
    draining = false
    if (pending.length > 0) scheduleDrain()
    else resolveIdle()
  })
}

/** Queue a managed-text version and return immediately. FIFO order preserves the
 * exact save sequence used by latest-row dedup. Managed writers hand off their
 * completed, immutable Buffer, so the save path does no copy or hash work. */
export function record(absolutePath: string, bytes: Buffer): void {
  if (!accepting) return
  pending.push({ absolutePath, bytes })
  scheduleDrain()
}

/** Fatal/exit-only path. The catalog has already been published synchronously and
 * the process cannot wait for `setImmediate`, so attempt this one record now. This
 * deliberately ignores `accepting`: orderly shutdown closes the ordinary queue
 * before Node's final `exit` event, and a catalog save there must be allowed to
 * reopen the DB. The SQLite lock wait remains capped by the store's 100 ms busy
 * timeout. Ordinary saves must use {@link record}; this blocking is terminal-only. */
export function recordBeforeExit(absolutePath: string, bytes: Buffer): void {
  recordNow(absolutePath, bytes)
}

/** Wait until every queued record has either landed or failed. */
export function flushBackupStore(): Promise<void> {
  if (!draining && pending.length === 0) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}

/** Stop accepting work, give the FIFO a bounded drain, and close best-effort. The
 * process is terminating; tests reset the module before opening another root. */
export async function closeBackupStore(): Promise<void> {
  accepting = false
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    flushBackupStore(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, CLOSE_DRAIN_TIMEOUT_MS)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  // A normal queue is empty here. On timeout, abandon the remaining best-effort
  // history rather than keep quit unbounded; every live managed file is already
  // safely published, and the next save starts a fresh record.
  pending.length = 0
  try {
    db?.close()
  } catch {
    // best-effort: a close failure on shutdown/teardown is harmless
  }
  db = null
  initialized = false
}
