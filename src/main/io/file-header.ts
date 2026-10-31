import type { DatabaseSync } from 'node:sqlite'

/**
 * Every file TapeBox defines says what it is and what wrote it
 * (file-identity-conventions): a `format` of owner, kind and version, and a
 * `writer` of the program that serialized it. This is the one place the header
 * is built and checked, for JSON and SQLite. Readers check `format` alone and
 * never read `writer`. This module imports nothing at run time, so the store
 * worker threads can run it as it is.
 */

/** The product every TapeBox format belongs to. */
export const FORMAT_OWNER = 'tapebox'

export type FileFormat = { readonly kind: string; readonly version: number }

/** The program that serializes a file: its package name and release. */
export type FileWriter = { name: string; version: string }

/** Every format TapeBox defines. Every one is format 1. */
export const FORMATS = {
  /** shelf.json */
  shelf: { kind: 'shelf', version: 1 },
  /** A tape's own `<inbox|shelf>/<id>/tape.json`. */
  tape: { kind: 'tape', version: 1 },
  /** config.json */
  config: { kind: 'config', version: 1 },
  /** layout.json */
  layout: { kind: 'layout', version: 1 },
  /** dependencies.json */
  dependencies: { kind: 'dependencies', version: 1 },
  /** api-keys.json */
  apiKeys: { kind: 'api-keys', version: 1 },
  /** A tape's sidecar in the collection, and the copy an export writes. */
  sidecar: { kind: 'sidecar', version: 1 },
  /** `bin/<name>.json`, the installed version beside a managed binary. */
  binaryVersion: { kind: 'binary-version', version: 1 },
  /** backups.sqlite3. One row per file per launch (`session_id`). */
  backups: { kind: 'backups', version: 1 },
  /** records.sqlite3 */
  records: { kind: 'records', version: 1 },
} as const satisfies Record<string, FileFormat>

const HEADER_KEYS = ['format', 'writer'] as const

/**
 * A store written in a newer format than this build reads. It is intact: the
 * caller reports it by name and leaves it exactly as it is.
 */
export class NewerFormatError extends Error {
  // Declared fields, not parameter properties: Node's type stripping runs this
  // file as it is in the store worker threads.
  readonly path: string
  readonly version: number

  constructor(path: string, version: number, supported: number) {
    super(`${path} is format ${version}; this build reads format ${supported}`)
    this.name = 'NewerFormatError'
    this.path = path
    this.version = version
  }
}

/** A read file's content has its header taken off. */
export type StoreJson =
  | { status: 'read'; value: Record<string, unknown> }
  | { status: 'newer'; version: number }
  | { status: 'unreadable'; error: Error }

/** Parse a JSON file's text and check its header against `format`. A root that
 * is not an object is unreadable. */
export function parseStoreJson(text: string, format: FileFormat): StoreJson {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { status: 'unreadable', error: error as Error }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unreadable', error: new Error('the root is not a JSON object') }
  }
  return checkFileHeader(raw as Record<string, unknown>, format)
}

/** Check a parsed file's `format`: owner and kind exactly as expected, and the
 * current version. A higher whole version is newer and left as it is; a
 * missing or malformed header, another owner or kind, or a lower version is
 * unreadable. `writer` is never read. */
export function checkFileHeader(value: Record<string, unknown>, expected: FileFormat): StoreJson {
  const unreadable = (why: string): StoreJson => ({ status: 'unreadable', error: new Error(`not a TapeBox ${expected.kind} file: ${why}`) })
  const format = value['format']
  if (format === null || typeof format !== 'object' || Array.isArray(format)) return unreadable('it has no format header')
  const { owner, kind, version } = format as Record<string, unknown>
  if (typeof owner !== 'string' || typeof kind !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return unreadable('its format header is malformed')
  }
  if (owner !== FORMAT_OWNER || kind !== expected.kind) return unreadable(`it is a ${owner} ${kind} file`)
  if (version > expected.version) return { status: 'newer', version }
  if (version !== expected.version) return unreadable(`it is format ${version}; this build reads format ${expected.version}`)
  const content = { ...value }
  for (const key of HEADER_KEYS) delete content[key]
  return { status: 'read', value: content }
}

/** `data` led by its header, replacing any `format` or `writer` it held. */
export function withFileHeader(data: object, format: FileFormat, writer: FileWriter): Record<string, unknown> {
  const content = { ...(data as Record<string, unknown>) }
  for (const key of HEADER_KEYS) delete content[key]
  return {
    format: { owner: FORMAT_OWNER, kind: format.kind, version: format.version },
    writer: { name: writer.name, version: writer.version },
    ...content,
  }
}

/**
 * An open SQLite store's format version, `PRAGMA user_version`, or null for a
 * brand-new database: no marker and no tables yet. An existing database without
 * its marker is unreadable, and this throws.
 */
export function databaseFormatVersion(db: DatabaseSync, path: string): number | null {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`${path} has an invalid format version (PRAGMA user_version)`)
  if (version !== 0) return version
  const { tables } = db.prepare('SELECT count(*) AS tables FROM sqlite_schema').get() as { tables: number }
  if (tables > 0) throw new Error(`${path} has no format version (PRAGMA user_version)`)
  return null
}

/** The table a SQLite store's header lives in, beside `PRAGMA user_version`. */
export const FILE_HEADER_TABLE = 'CREATE TABLE IF NOT EXISTS file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)'

/**
 * Admit an existing SQLite store when it is opened: its version as for JSON,
 * then its `file_header` owner and kind. Unmarked, lower, headerless and
 * foreign stores are unreadable; newer ones are protected. One TapeBox runs per
 * data root, so the format cannot change while a store is open.
 */
export function assertDatabaseCurrent(db: DatabaseSync, path: string, format: FileFormat): void {
  const version = databaseFormatVersion(db, path)
  if (version === null) throw new Error(`${path} has no format version (PRAGMA user_version)`)
  if (version > format.version) throw new NewerFormatError(path, version, format.version)
  if (version !== format.version) throw new Error(`${path} is format ${version}; this build reads format ${format.version}`)
  const { present } = db.prepare("SELECT count(*) AS present FROM sqlite_schema WHERE type = 'table' AND name = 'file_header'").get() as { present: number }
  if (present === 0) throw new Error(`${path} is not a TapeBox ${format.kind} database: it has no file_header table`)
  const rows = db.prepare("SELECT key, value FROM file_header WHERE key IN ('format.owner', 'format.kind')").all() as Array<{ key: string; value: string }>
  const header = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  if (header['format.owner'] !== FORMAT_OWNER || header['format.kind'] !== format.kind) {
    throw new Error(`${path} is not a TapeBox ${format.kind} database: it is a ${header['format.owner']} ${header['format.kind']} database`)
  }
}

/** Write a SQLite store's header rows: the format, and this program as its
 * writer, which an open for writing rewrites. Runs inside the caller's
 * transaction. */
export function writeDatabaseHeader(db: DatabaseSync, format: FileFormat, writer: FileWriter): void {
  db.exec(FILE_HEADER_TABLE)
  const set = db.prepare('INSERT INTO file_header (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  set.run('format.owner', FORMAT_OWNER)
  set.run('format.kind', format.kind)
  set.run('writer.name', writer.name)
  set.run('writer.version', writer.version)
  db.exec("DELETE FROM file_header WHERE key LIKE 'writer.caller.%'")
}
