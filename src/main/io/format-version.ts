import type { DatabaseSync } from 'node:sqlite'

/**
 * Every store's format version, and the one way each kind of store reads and
 * writes its marker (store-recovery-conventions). Every format TapeBox owns is
 * format 1, and a reader accepts exactly its current marker. This module
 * imports nothing at run time, so the store worker threads can run it as it is.
 */
export const FORMAT_VERSIONS = {
  /** shelf.json */
  shelf: 1,
  /** A tape's own `<inbox|shelf>/<id>/tape.json`. */
  tape: 1,
  /** config.json */
  config: 1,
  /** layout.json */
  layout: 1,
  /** dependencies.json */
  dependencies: 1,
  /** api-keys.json */
  apiKeys: 1,
  /** A tape's sidecar in the collection, and the copy an export writes. */
  sidecar: 1,
  /** `bin/<name>.json`, the installed version beside a managed binary. */
  binaryVersion: 1,
  /** backups.sqlite3. One row per file per launch (`session_id`). */
  backups: 1,
  /** records.sqlite3 */
  records: 1,
} as const

/** The marker's key in a JSON store. */
export const FORMAT_VERSION_KEY = 'formatVersion'

/**
 * A store written in a newer format than this build reads. It is intact: the
 * caller reports it by name and leaves it exactly as it is.
 */
export class NewerFormatError extends Error {
  // Declared fields, not parameter properties: Node's type stripping runs this
  // file as it is in the records reader thread.
  readonly path: string
  readonly version: number

  constructor(path: string, version: number, supported: number) {
    super(`${path} is format ${version}; this build reads format ${supported}`)
    this.name = 'NewerFormatError'
    this.path = path
    this.version = version
  }
}

export type StoreJson =
  | { status: 'read'; value: Record<string, unknown> }
  | { status: 'newer'; version: number }
  | { status: 'unreadable'; error: Error }

/**
 * Parse a JSON store's text and read its marker against `current`. A root that is
 * not an object is unreadable. The returned value still holds the marker; each
 * store's own shape ignores it.
 */
export function parseStoreJson(text: string, current: number): StoreJson {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { status: 'unreadable', error: error as Error }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unreadable', error: new Error('the root is not a JSON object') }
  }
  return checkFormatVersion(raw as Record<string, unknown>, current)
}

/** Only the current marker is read. A higher whole number is a newer format,
 * left as it is; a missing, lower or malformed marker is unreadable, like any
 * other file this build cannot read. */
export function checkFormatVersion(value: Record<string, unknown>, current: number): StoreJson {
  const marker = value[FORMAT_VERSION_KEY]
  if (marker === current) return { status: 'read', value }
  if (typeof marker === 'number' && Number.isSafeInteger(marker) && marker > current) return { status: 'newer', version: marker }
  return { status: 'unreadable', error: new Error(`${FORMAT_VERSION_KEY} is ${JSON.stringify(marker) ?? 'missing'}; this build reads format ${current}`) }
}

/** `data` with `formatVersion` as its first key, replacing any marker it held. */
export function withFormatVersion(data: object, version: number): Record<string, unknown> {
  const { [FORMAT_VERSION_KEY]: _replaced, ...rest } = data as Record<string, unknown>
  return { [FORMAT_VERSION_KEY]: version, ...rest }
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

/**
 * Admit an existing SQLite store when it is opened. Unmarked, invalid and lower
 * markers are unreadable; newer markers are protected. One TapeBox runs per data root, so
 * the format cannot change while a store is open.
 */
export function assertDatabaseCurrent(db: DatabaseSync, path: string, current: number): void {
  const version = databaseFormatVersion(db, path)
  if (version === null) throw new Error(`${path} has no format version (PRAGMA user_version)`)
  else if (version > current) throw new NewerFormatError(path, version, current)
  else if (version !== current) throw new Error(`${path} is format ${version}; this build reads format ${current}`)
}
